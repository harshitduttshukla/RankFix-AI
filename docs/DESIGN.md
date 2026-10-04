# GSC Existing-Blog Optimizer — V1 Design

Status: **design, awaiting approval before Phase 1.**
Prisma schema: [backend/prisma/schema.prisma](../backend/prisma/schema.prisma)

---

## 1. Architecture

Modular monolith: one Express API process plus one worker process. Both are built from the same `backend/` codebase and share the same services and repositories.

```
 Browser ── Next.js (frontend/, TanStack Query) ──HTTP+cookie──▶ Express API (backend/)
                                                                  │
               routes → middleware(auth, tenant, zod) → controllers → services → repositories → Prisma → PostgreSQL
                                                                  │
                                                       enqueue ──▶ BullMQ/Redis ──▶ worker process (same codebase)
                                                                                     ├─ gsc-sync
                                                                                     ├─ website-crawl
                                                                                     └─ measurement (delayed jobs)
 External: Google OAuth + Search Console API · customer website (crawl, SSRF-guarded) · Claude API (Anthropic) · customer Site Update API
```

Module boundaries (in `src/services/*`):

| Module | Owns | Must not |
|---|---|---|
| `gsc` | OAuth, property listing, Search Analytics sync, perf queries | know about AI or content |
| `website` | crawler, robots, sitemap, extraction, page/version persistence | call AI |
| `optimization` | matching, `OpportunityDetector` (pure, deterministic), state machine, proposal/approval/apply orchestration | let AI choose opportunities or IDs |
| `ai` | `PageAnalysisService`, `OptimizationProposalService`, prompt building, Zod validation | write to DB directly |
| `content` | `ContentUpdateProvider` (Site Update API), diff/patch, optimistic concurrency | — |
| `measurement` | baseline/post windows, comparison | claim causality |

**Single update mechanism (V1): Site Update API.** Customer sites are custom-built, so the customer exposes two HTTPS endpoints that we specify in `docs/site-update-api.md`, and we ship a reference Express handler for them to adapt:

```
GET  {updateEndpointUrl}/page?url=<abs url>   → { id, url, title, metaDescription, bodyHtml, contentHash }
PUT  {updateEndpointUrl}/page                  ← { id, url, expectedHash, title, metaDescription, bodyHtml }
                                               → 200 { contentHash } | 409 { error: "HASH_MISMATCH" }
```
- **Request signing:** every request carries `X-Signature: sha256=HMAC(secret, timestamp + "." + method + path + body)` and `X-Timestamp`. The site rejects requests older than 5 minutes.
- **Concurrency check on the site side:** the site applies a PUT only if its current hash equals `expectedHash`. That gives us optimistic concurrency at the source of truth.
- **Hash definition:** `contentHash = sha256(title + "\n" + metaDescription + "\n" + bodyHtml)`, computed identically on both sides. The spec includes test vectors.
- **SSRF:** `updateEndpointUrl` must be on the website's own host and goes through the same SSRF guard as the crawler.

## 2. Tenancy & security

- Auth: email/password only, no Sign in with Google in V1 (argon2id) → short-lived access JWT (15 min) and a rotating refresh token, both in `HttpOnly; Secure; SameSite=Lax` cookies. CSRF protection: SameSite plus a double-submit token on mutating routes.
- `requireAuth` → `req.user`. `requireProjectAccess(minRole)` loads `Project` joined to a `Membership` for `req.user`, then sets `req.tenant = {organizationId, projectId, role}`. `organizationId` is never read from the client.
- Every repository method takes `tenant: TenantContext` as its first argument and puts it in the `where`. A cross-tenant lookup returns **404**, never 403, so ids don't leak.
- Integrity enforced in the DB: `OptimizationOpportunity` has a composite FK `(pageId, websiteId, projectId, organizationId)` → `ContentPage`. This means an opportunity cannot exist for a missing page, or for a page in another website, project, or tenant.
- GSC: scope `https://www.googleapis.com/auth/webmasters.readonly` only, plus `openid email`. The OAuth `state` is a signed, single-use nonce bound to user+project. Refresh tokens and the site HMAC secret are encrypted with AES-256-GCM, using a key from `ENCRYPTION_KEY`.
- SSRF: only http/https, ports 80/443, hostname must equal `website.hostname` (or `www.` variant). DNS is resolved and private, loopback, link-local, CGNAT and metadata ranges (IPv4+IPv6) are rejected. The validated IP is pinned for the connection. Redirects are re-validated hop by hop (max 5). Body limit 5 MB, timeout 15 s.
- Rate limits: global per-IP, a tighter limit on `/auth/*`, and per-project limits on AI endpoints.
- Audit log covers: auth events, gsc.connected/disconnected/property.selected, crawl started, proposal.created/edited/approved/rejected, page.updated, update.failed, measurement.completed.

## 3. State machines

**Opportunity** (allowed transitions only, enforced in `opportunity-state.ts` and with a conditional `updateMany where status = from`):

```
DETECTED → ANALYZING → PROPOSED → AWAITING_APPROVAL → APPROVED → APPLYING → APPLIED → MEASURING → COMPLETED
                                   AWAITING_APPROVAL → REJECTED
                                   REJECTED → ANALYZING            (regenerate after rejection)
                                   AWAITING_APPROVAL → ANALYZING   (regenerate; old proposal SUPERSEDED)
ANALYZING | APPLYING | MEASURING → FAILED ;  FAILED → DETECTED (retry)
DETECTED → DISMISSED (superseded by a newer detection run)
```
`PROPOSED` is transient. The proposal is persisted and the status then moves straight to `AWAITING_APPROVAL` in the same transaction.

**Proposal**: `AWAITING_APPROVAL → APPROVED | REJECTED | SUPERSEDED`, `APPROVED → APPLIED | FAILED`. Editing is allowed only while `AWAITING_APPROVAL`. An edit records `editedById` and invalidates nothing else. Approval stores `proposalHash`, and apply refuses if the content hash no longer matches.

## 4. Core algorithms

**Page matching**: normalize both sides by lowercasing the host, stripping `www.` per the property, dropping the fragment and tracking params (`utm_*`, `gclid`, `fbclid`) and the trailing slash (except root). A GSC row matches only if `ContentPage(websiteId, url)` exists with `status = ACTIVE`. The crawler's canonical URL is also indexed. Unmatched GSC pages are reported as "not crawled" and never turned into opportunities.

**OpportunityDetector** (pure function, unit-tested). Window = last 28 complete days (GSC lag of 3 days), previous = the 28 days before that. Minimum 200 impressions.

```
expectedCtr(pos)  = position-CTR curve (config table, e.g. 1:28%, 2:15%, 3:11%, 4:8%, 5:6%, … 10:2.5%, 15:1%)
ctrGap            = clamp((expectedCtr - ctr) / expectedCtr, 0, 1)
ctrScore          = 35 * ctrGap
impressionScore   = 25 * clamp(log10(impr) / log10(50_000), 0, 1)
rankingScore      = 25 * (pos in [4,15] ? 1 - |pos - 8| / 8 : 0)       // peaks around pos 8
trendScore        = 15 * clamp(max(-Δclicks%, -ΔCTR%) / 50%, 0, 1)
score             = round(sum, 1)   // 0–100, threshold 30
```
`opportunityType` is the dominant signal. Evidence is a set of deterministic template strings, e.g. *"This page received 18,400 impressions in the last 28 days but has a 1.2% CTR (expected ≈ 4.5% at position 7.8)."* Re-detection updates any open opportunity for the page and never duplicates it (one non-terminal opportunity per page).

**AI** uses the interface `AiProvider.generateStructured<T>(zodSchema, system, user)`. V1 has one implementation, `ClaudeProvider`, built on `@anthropic-ai/sdk`:
- **Call:** `client.messages.parse({ model, max_tokens: 16000, thinking: {type:'adaptive'}, output_config: { effort, format: zodOutputFormat(schema) } })`. The response is then re-validated with `schema.safeParse`.
- **Model and effort:** model comes from `AI_MODEL` (default `claude-opus-5-5`), effort from `AI_EFFORT` (default `high`).
- **Failure handling:** check `stop_reason` before reading output. `refusal` → `AI_REFUSED`, and `max_tokens` → retry once. Invalid output is retried once, then the opportunity → `FAILED`.
- **Other providers:** OpenAI or anything else can be added later behind the same interface without touching services.
- *PageAnalysis* input: the current version's title, meta, H1, headings, sections (body split into sections by H2/H3), top 25 queries with metrics, and evidence. Output: per-dimension findings, each citing a `sectionId` that must exist. Unknown section ids are rejected.
- *Proposal* AI output contains **only** `summary, reason, changes[], confidence`. Each change is `{type, sectionId | "title" | "meta", before, after, rationale}`. The backend:
  1. Checks every `before` is an exact substring of the current version (otherwise reject the output).
  2. Builds `beforeContent` and `afterContent` by applying the changes itself.
  3. Attaches `opportunityId`, `pageId`, `projectId`, `baseVersionId` and `evidence` from the DB.
  4. Rejects proposals that change more than 40% of body text, add `<script>`/iframes, or remove links.
  Any extra keys (`pageId` etc.) in the AI JSON fail the strict schema.

**Apply** (single DB transaction around steps 5–8, with external I/O before step 5):
1. Load proposal (tenant-scoped). Require `APPROVED` with an approval whose hash matches, and role ≥ EDITOR.
2. Check `page.currentVersionId == proposal.baseVersionId`, otherwise **409 STALE_CONTENT_VERSION**.
3. `provider.getPage()` fetches the live content. Hash it and compare to the base version. A mismatch means the CMS was edited outside the system → snapshot it as a new CRAWL version → **409 STALE_CONTENT_VERSION**.
4. Opportunity → `APPLYING`. `provider.updatePage()` sends the after-content.
5. Insert a `PRE_UPDATE` version (previous), then an `OPTIMIZATION` version (new).
6. `UPDATE ContentPage SET currentVersionId=new, currentVersionNo=n+1 WHERE id=? AND currentVersionNo=n`. Zero rows → roll back → 409.
7. Run → APPLIED, proposal → APPLIED, opportunity → APPLIED → MEASURING. Write the audit log.
8. Capture the BASELINE measurement (28 days before apply) and enqueue a delayed `measurement` job at `applyDate + MEASUREMENT_DAYS (default 28) + 3`.

On provider failure the run is FAILED, the opportunity is FAILED, the error is audited and no version is created.

**Measurement**: POST window = `[applyDate+1, applyDate+N]`. Page-level totals come from the `query=''` rows. If data is incomplete, the job re-delays itself (max 3 times). The UI labels results "Performance after optimization" and shows deltas with no causal language.

## 5. API contracts

All bodies are validated with Zod schemas in `backend/src/schemas`. Errors use `{ error: { code, message, details? } }`. Codes: `VALIDATION_ERROR, UNAUTHENTICATED, NOT_FOUND, FORBIDDEN, INVALID_STATE_TRANSITION, STALE_CONTENT_VERSION, GSC_NOT_CONNECTED, AI_OUTPUT_INVALID, UPDATE_PROVIDER_ERROR, RATE_LIMITED`. Long-running work returns `202 { jobId }`.

| Method & path | Role | Body → Response |
|---|---|---|
| POST `/api/auth/register` · `/login` · `/logout` · `/refresh`, GET `/api/auth/me` | — | `{email,password,name?}` → `{user, organizations}` (+cookies) |
| GET/POST `/api/projects` | member / ADMIN | `{name}` → `Project` |
| POST `/api/projects/:projectId/websites` | ADMIN | `{baseUrl, blogPathPrefix?, updateEndpointUrl?, updateSecret?}` → `Website` (secret never echoed) |
| POST `/api/websites/:websiteId/crawl` | EDITOR | → `202 {jobId}` |
| GET `/api/websites/:websiteId/pages?status&cursor` | VIEWER | → `{items: PageSummary[], nextCursor}` |
| POST `/api/projects/:projectId/gsc/connect` | ADMIN | → `{authUrl}` |
| GET `/api/gsc/oauth/callback` | (state-bound) | redirect → `/settings/gsc` |
| GET `/api/projects/:projectId/gsc/properties` | ADMIN | → `{properties:[{siteUrl, permissionLevel}]}` |
| POST `/api/projects/:projectId/gsc/select-property` | ADMIN | `{websiteId, siteUrl}` → `GSCProperty` (siteUrl must match website host) |
| POST `/api/projects/:projectId/gsc/sync` | EDITOR | `{days?≤480}` → `202 {jobId}` |
| GET `/api/projects/:projectId/gsc/performance?pageUrl&start&end` | VIEWER | → `{totals, daily[], queries[]}` |
| DELETE `/api/projects/:projectId/gsc` | ADMIN | revokes the token at Google, deletes connection |
| GET `/api/projects/:projectId/optimization/opportunities?status&type&sort&cursor` | VIEWER | → `{items: OpportunityRow[]}` |
| POST `/api/projects/:projectId/optimization/detect` | EDITOR | → `{created, updated}` (sync; cheap SQL) |
| GET `…/opportunities/:id` | VIEWER | → `OpportunityDetail {page, currentVersion, gscMetrics, queries, evidence, analysis?, latestProposal?}` |
| POST `…/opportunities/:id/analyze` | EDITOR | → `PageAnalysis` (sync, ~20 s; 202 if >25 s) |
| POST `…/opportunities/:id/proposal` | EDITOR | → `Proposal` (requires analysis) |
| GET `…/proposals/:id` | VIEWER | → `Proposal & {page, gscMetrics}` |
| PATCH `…/proposals/:id` | EDITOR | `{changes}` → `Proposal` (re-validated, rebuilt afterContent) |
| POST `…/proposals/:id/approve` | EDITOR | `{comment?}` → `Proposal` |
| POST `…/proposals/:id/reject` | EDITOR | `{comment}` → `Proposal` |
| POST `…/proposals/:id/apply` | EDITOR | → `{run, newVersion}` · 409 `STALE_CONTENT_VERSION` |
| GET `/api/projects/:projectId/optimization/history` | VIEWER | → `{items:[{page, opportunityType, appliedAt, status, before, after}]}` |
| GET `/api/projects/:projectId/optimization/:runId/measurement` | VIEWER | → `{baseline, post?, deltas?, nextMeasurementAt}` |
| GET `/api/pages/:pageId/versions` | VIEWER | → `ContentPageVersion[]` |

Website- and page-scoped routes resolve `website → projectId` first, then run the same project-access check.

## 6. API types (`backend/src/schemas`, Zod → `z.infer`)

```ts
OpportunityRow     { id, pageUrl, pageTitle, opportunityType, score, impressions, clicks, ctr, position, status }
Evidence           { kind: 'ctr_gap'|'impressions'|'position'|'trend'|'query', text, metric, value, comparison? }
ProposalChange     { type: 'TITLE'|'META_DESCRIPTION'|'SECTION_REWRITE'|'SECTION_EXPAND'|'HEADING'|'INTENT_ALIGNMENT'|'INTERNAL_LINK'|'CLARIFICATION',
                     target: 'title'|'meta'|{sectionId}, before: string, after: string, rationale: string }
AiProposalOutput   z.object({ summary, reason, changes: ProposalChange[].min(1).max(12), confidence: z.number().min(0).max(1) }).strict()
PageAnalysis       { title, meta, h1, headingStructure, contentQuality, queryRelevance, intentAlignment: Finding,
                     weakSections: {sectionId, issue}[], missingTopics[], repetition[], internalLinkIdeas: {anchor, targetPageId}[] }
                     // targetPageId must be an existing ContentPage in the same website
```

## 7. Folder structure

Two independent npm projects, no monorepo or workspaces. Zod API schemas live in the backend; the frontend keeps its own copies of the response types it uses.

```
backend/                 Express + TypeScript + Prisma (+ BullMQ from Phase 2)
  prisma/schema.prisma
  src/{app.ts, server.ts, worker.ts, config/, routes/, controllers/, services/{gsc,website,optimization,content,ai,measurement}/,
       repositories/, middleware/, schemas/, workers/, queues/, providers/{ai,content}/, utils/, types/}
  test/                  Vitest + Supertest against the docker Postgres
frontend/                Next.js + Tailwind + TanStack Query
  app/{login,register,dashboard,optimization/...,settings/gsc}/  lib/  components/  e2e/
docs/                    DESIGN.md, site-update-api.md
docker-compose.yml       postgres only for now (redis added when queues land in Phase 2); backend/frontend run locally with npm
```

## 8. Implementation plan

| Phase | Deliverable | Gate (must pass before next) |
|---|---|---|
| 1 Foundation | backend/ + frontend/, compose (postgres), Prisma migrate, auth, orgs/projects/websites, tenant middleware, error/validation/rate-limit, Next shell + login | auth + tenant-isolation integration tests green |
| 2 GSC | OAuth, encryption, properties, select, sync worker, perf queries | OAuth state test, sync upsert idempotency, failed-sync state |
| 3 Website | SSRF fetcher, robots, sitemap, Cheerio extraction, versions on hash change | SSRF tests (private IPs, redirects), extraction fixtures |
| 4 Opportunities | matching, detector, API, list/detail UI | scoring unit tests, existing-page-only, DB FK test |
| 5 AI | provider abstraction, Claude provider, analysis, proposal, validators | invalid/hostile AI output rejected, pageId immutability |
| 6 Approval | review UI w/ diff, approve/reject/edit | state-transition tests |
| 7 Update | Site Update API provider + spec + reference handler, apply transaction, stale detection, audit | stale + concurrent-apply tests, version chain |
| 8 Measurement | baseline, delayed job, history UI | window math tests, incomplete-data re-delay |
| 9 Hardening | Playwright happy path, logging (pino), health checks, security pass | full E2E green |

Real-integration check: the definition of done requires real Google and Anthropic credentials and a site implementing the Site Update API. Automated tests use stub HTTP servers. I'll mark the loop done only after a manual run against a real GSC property and a site running the Site Update API, which needs your credentials.
