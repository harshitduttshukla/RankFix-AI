# RankFix AI: Full Project Audit

- **Date:** 2026-10-15
- **Commit audited:** `01a6990` (branch `main`, clean working tree)
- **Scope:** the whole repository, using static inspection plus safe local checks. No application code, schema, data or configuration was changed.

Evidence tags used throughout:
- **[V] Verified:** read directly in code or proven by an executed check.
- **[I] Inferred:** a reasoned conclusion from the cited evidence.
- **[NV] Not verified:** the evidence or environment needed to check it was unavailable.

---

## 1. Executive summary

**Overall readiness: Partially Ready.** The product isn't ready for production. After one small logging fix, it could run as an *advisory* tool for a controlled pilot.

Phases 1–6 (foundation, Search Console, crawler, opportunity engine, AI analysis and drafts, human review) are built carefully and covered by tests. Tenant scoping, SSRF defenses, approval state machines and AI output validation are all better than typical for this stage. The product still can't do what it exists to do. **No approved change can reach a website (Phase 7), and no result can be measured (Phase 8).** The intended loop stops at "approved proposal". The landing page states this honestly.

| Severity | Count | Items |
|---|---|---|
| Critical | 0 | none |
| High | 3 | SEC-01 (auth tokens written to logs), CORE-01 (no publishing), CORE-02 (no measurement) |
| Medium | 10 | SEC-02, SEC-03, LIFE-01, GSC-01, GSC-02, AI-01, OPS-01, OPS-02, REV-01, SAAS-01 |
| Low | 13 | SEC-04/05/06, DATA-01/02/03, REV-02, AI-02, ARCH-01, OPS-03/04, ERR-01, DOC-01 |

**What works end to end, proven by integration tests with a fake Google client, a local fixture site and a fake AI provider:**
register → organization → project → website → Search Console connect and property mapping → sync → crawl → deterministic opportunities with evidence → AI analysis → validated drafts → edit / originality check / approve or reject → page-version-bound proposal → final approval with audit trail.

**Biggest blockers**
1. **SEC-01:** login, registration and refresh responses write the access JWT and the refresh token to application logs.
2. **CORE-01:** approved proposals can't be applied or verified. `OptimizationRun` and the `APPLYING`/`APPLIED` states exist only in the schema.
3. **CORE-02:** no post-change measurement exists. `OptimizationMeasurement` is unused.
4. **LIFE-01:** an approved proposal leaves its opportunity in `PROPOSED` permanently, so that page/type is never detected again.

**Recommended next phase:** fix SEC-01, then build **Phase 7a, "Apply-and-verify (manual apply + recrawl verification)"**: a CMS-agnostic way to record that an approved proposal was applied, confirm it on the live page by deterministic recrawl, and capture a baseline. Details in §12.

---

## 2. Verified repository and technology inventory [V]

| Area | Finding |
|---|---|
| Layout | `backend/` (Express 5, TypeScript, Prisma 6.19.3, PostgreSQL 16), `frontend/` (Next.js 16.3.8, React 19.2, TanStack Query 5, Tailwind 4), `docker-compose.yml` (Postgres on :5433, Redis on :6380), `docs/` (phase docs) |
| Entry points | `backend/src/server.ts` (API), `backend/src/worker.ts` (4 BullMQ workers: gsc-sync, website-crawl, opportunity-detect, ai-analysis) |
| Size | 220 tracked files; about 6.7k lines in `backend/src/services` |
| Database | 9 migrations, `backend/prisma/schema.prisma` (28 models). Partial unique indexes are written as raw SQL in the migrations |
| Queues | BullMQ on Redis. Job IDs equal DB row IDs (crawl, AI run), or deduplication keys are used (GSC sync per property) |
| AI | `AIProvider` interface (`services/ai/ai.provider.ts`) with `OpenRouterProvider` and `GeminiProvider` implementations. Prompts are versioned (`prompts/*-v1/v2.ts`) |
| Tests | Vitest + Supertest, 20 files, **426 tests**, run against a real Postgres test database and Redis db 1 |
| CI/CD | **None.** There is no `.github/` folder and no pipeline config |
| Deployment | **None.** There are no app Dockerfiles, no production compose file, no infrastructure config. Only dev Postgres/Redis containers |
| Lint | Frontend only (`eslint.config.mjs`). The backend has a typecheck but no linter |
| Naming drift | "Blog Optimizer" (README), "gsc-optimizer" (package/JWT issuer), "BlogPilot" (crawler user agent, OpenRouter `X-Title`), "RankFix AI" (landing page) |

---

## 3. Feature status matrix

Status values: Implemented · Partially Implemented · Mocked · Broken · Missing · Not Verified.

### A. SaaS foundation

| Feature | Actual implementation / evidence | Status | Tests | Risks / next action |
|---|---|---|---|---|
| Signup / login | `services/auth/auth.service.ts`: argon2id, timing-equalized unknown-email path, `authLimiter` 20 per 15 min | Implemented | `auth.test.ts` | SEC-01 token logging |
| Sessions | HS256 access JWT (15 min, cookie path `/api`). Refresh tokens are random and stored as sha256, rotated, with family revocation on reuse (`session.repository.ts`) | Implemented | `auth.test.ts` | Expired sessions are never pruned (OPS-03) |
| CSRF | Double-submit cookie check on every non-GET `/api` request (`csrf.middleware.ts`), SameSite=Lax | Implemented | indirectly, in all API tests | — |
| Password reset / email verification | none | **Missing** | — | SAAS-01 |
| Organizations | Auto-created as OWNER on register (`user.repository.createWithOrganization`) | Partially Implemented | `tenant-isolation.test.ts` | No invites, role management or second member: SAAS-01 |
| Roles | `OWNER > ADMIN > EDITOR > VIEWER` enforced per route (`requireProjectAccess(minRole)`) | Implemented | role tests in review, crawler and tenant tests | No separation of duties (REV-01) |
| Projects / websites | Create and list only. No update or delete | Partially Implemented | `tenant-isolation.test.ts` | Website ownership isn't verified (SEC-02) |
| Tenant isolation | Every repository query filters by `organizationId` + `projectId`. Composite FKs on Website/ContentPage/Opportunity. Non-members get 404 | Implemented | 17+ cross-tenant tests across 7 files | — |
| Billing | none | Missing (not needed for a pilot) | — | P4 |
| Onboarding / empty states | Dashboard, website and settings pages exist | Partially Implemented | none (no frontend tests) | [NV] UX |

### B. Google Search Console

| Feature | Evidence | Status | Tests | Notes |
|---|---|---|---|---|
| OAuth start / callback | `gsc.service.ts` `connect` / `handleCallback`. Signed, 10-minute, single-use state (`oauth-state.ts`, Redis `GETDEL` nonce) bound to user and project. ADMIN role re-checked at callback. Scope verified. Redirect target is fixed to `FRONTEND_ORIGIN` | Implemented | `gsc.test.ts` (23) | Real Google flow **[NV]**: tests use `test/fake-gsc.ts` |
| Token storage | Refresh token AES-256-GCM encrypted (`utils/crypto.ts`). `invalid_grant` marks the connection revoked | Implemented | `gsc.test.ts` | No key-rotation path |
| Property mapping | Only properties the Google account has verified access to, and only if the property covers the website host | Implemented | `gsc.test.ts` | Switching properties keeps old rows (GSC-01) |
| Sync | One day at a time, `dataState: 'final'`, 25k-row pagination, separate page-total and page+query fetches, URL normalization and merging, idempotent `replaceDay`, 3-day overlap on incremental sync, dedupe per property, 3 attempts with exponential backoff | Implemented | `gsc.test.ts` | Real API quotas and rate limits **[NV]**. No scheduled automatic sync (OPS-04) |
| Disconnect | Revokes at Google, then cascade-deletes properties and **all analytics** | Implemented | `gsc.test.ts` | Destroys future measurement baselines (GSC-02) |

### C. Website crawler

| Feature | Evidence | Status | Tests | Notes |
|---|---|---|---|---|
| SSRF protection | `safe-fetch.ts` + `ip-policy.ts`: scheme, credential and port allowlist (80/443). DNS resolved and checked **inside the socket lookup**, so rebinding has no TOCTOU window. Every redirect hop re-validated and scope-checked. Byte cap and timeouts | Implemented | `crawler-network.test.ts` (16) | 6to4/Teredo IPv6 ranges aren't blocked (SEC-05) |
| robots / sitemaps | `robots.service.ts`, `sitemap.service.ts` (index recursion, caps). Falls back to following links | Implemented | `crawler-discovery.test.ts` | — |
| Extraction | `extract.ts`: metadata, headings, sections, links, images, JSON-LD | Implemented | `crawler-extract.test.ts` (17) | — |
| Playwright fallback | `renderer.ts`: every browser request is proxied through `safeFetch`. Only GET, no WebSockets or service workers | Implemented | `crawler-render.test.ts` (ran and passed) | — |
| Versioning | New `ContentPageVersion` only when the semantic content hash changes. Optimistic `currentVersionNo` check | Implemented | `crawler-pipeline.test.ts` | Stores `rawHtml` and `renderedHtml` per version without retention (DATA-02) |
| Concurrency / limits | Serializable "one active crawl per website" check. Page, time and concurrency caps. Polite rate gate. One retry on 429/503 | Implemented | `crawler-pipeline.test.ts` | Whole-site crawl only, so a single page can't be recrawled (needed for Phase 7a) |

### D. Opportunity engine

| Feature | Evidence | Status | Notes |
|---|---|---|---|
| Types | `LOW_CTR`, `PAGE_ONE_NEAR_TOP`, `HIGH_IMPRESSIONS_LOW_CLICKS`, `PERFORMANCE_DECLINE`, `CONTENT_COVERAGE_SIGNAL` (`opportunity-detector.service.ts` `RULES`) | Implemented | Thresholds come from env and are snapshotted per run |
| Determinism and evidence | Pure `detectPageOpportunities`. Evidence, score breakdown and top queries stored per row. Windows end at the last synced final day | Implemented | `opportunity-engine.test.ts` (29) |
| Deduplication / lifecycle | Partial unique index allows one open opportunity per (page, type). Refresh only while `DETECTED`/`REVIEWED`. Snooze after a user dismisses. `SIGNAL_CLEARED` auto-dismiss | Implemented | **LIFE-01**: `PROPOSED` is a dead end |
| Only existing pages | SQL join to `ACTIVE` ContentPages plus a composite FK | Implemented | `opportunity-api.test.ts` |

### E/F. AI analysis, recommendations and drafts

| Feature | Evidence | Status | Notes |
|---|---|---|---|
| Provider abstraction | `ai.provider.ts`, `openrouter.provider.ts`, `gemini.provider.ts`. Structured output (`json_schema` or prompt mode), Zod validation, timeouts, retry on transient errors | Implemented | Real provider calls **[NV]**: `openrouter.test.ts`/`gemini.test.ts` stub `fetch` |
| Background analysis | Queued and deduplicated (partial unique index on active run). Non-retryable errors fail once. Interrupted runs swept on worker start | Implemented | `ai-analysis.test.ts` (20) |
| Grounding: analysis | `ai.guardrails.ts`: queries must exist in the data, sections must exist, forbidden promissory wording, un-negated "guarantee" | Implemented (narrow) | Free-text rationale isn't checked for invented numbers or claims (AI-02) |
| Drafts (title/meta/H1/heading/intro) | `drafts.ts` `checkDraft`: length, single line, no markup or links, not identical to current, **numbers / price and credential terms / proper nouns must already appear on the page or in its queries** | Implemented | Strong, conservative design |
| Body-section rewrites | `section-body.ts`: fact preservation (numbers, names, caveat classes), length ratio, edit-distance bound, term overlap. Truncated sections refused. Reviewer-requested only | Implemented | `section-body-unit.test.ts` (16) |
| Draft history / binding | `RecommendationDraft` is append-only with `pageVersionId`, `sourceTextHash`, prompt version, tokens | Implemented | Synchronous request of up to 180 s (AI-01) |
| Cost tracking | Tokens stored per run and per draft. No per-organization cost reporting or budget | Partially Implemented | P3 |

### G. Human review and approval

| Feature | Evidence | Status | Notes |
|---|---|---|---|
| Review / edit / approve / reject | `review.service.ts`. AI original is immutable, human edit stored separately. Conditional `updateMany` state transitions | Implemented | `review.test.ts` (48) |
| Version binding and staleness | `approvalContext` requires the latest analysis to be non-stale and bound to the current page version. Staleness is sticky and audited (`staleness.ts`) | Implemented | Check runs outside the approval transaction (REV-02) |
| Proposal revisions | New revision supersedes the old one, never edits it. Partial unique index allows one live proposal per recommendation | Implemented | — |
| Final approval | `approveProposal` re-checks version and originality, writes `OptimizationApproval` with `proposalHash` | Implemented | The same person can approve both steps (REV-01) |
| Audit trail | `AuditLog` written in the same transaction for every decision | Implemented | Mutable at the DB level (DATA-01) |
| Bypass of approval | No apply path exists, so there's nothing to bypass yet | n/a | Phase 7 must enforce it |

### H. Publishing: **Missing**

`Website.updateEndpointUrl` / `updateSecretEnc` (HMAC secret, encrypted), `UpdateProviderType.SITE_UPDATE_API`, `OptimizationRun`, `VersionSource.OPTIMIZATION/PRE_UPDATE`, `RunStatus`, `ContentPage.externalId` and `proposalMatchesCurrentPage()` (`review.service.ts:792`) exist. **No route, service, worker or UI applies anything** (grep for `optimizationRun|APPLYING|externalId` in `src/` finds no usage) [V]. There's no WordPress or other CMS integration [V].

### I. Measurement: **Missing**

`OptimizationMeasurement` (`BASELINE`/`POST`, `dataComplete`) exists only in the schema. There are no jobs, services or reports [V].

### J. Originality

Implemented as an **internal-corpus** check (`services/originality/*`): n-gram fingerprints compared against this project's own crawled pages, with common-phrase suppression, a policy (`off|warn|require_ack|block`), a result TTL, and text-hash binding, so edited text needs a new check. **It doesn't search the public web** [V]. The UI and landing page say so explicitly [V]. Tested in `originality-unit.test.ts` and `review.test.ts`. The landing FAQ says checks cover "titles, meta descriptions, headings, and intro text", but code also covers existing section body text. That understates the feature (a minor doc fix).

### K. Frontend

Every backend route has a matching hook (`frontend/hooks/*`) [V]. Typecheck and lint are clean [V]. No `dangerouslySetInnerHTML` [V]. There are no frontend tests, and responsiveness and accessibility weren't exercised **[NV]**. The early-access form isn't connected, and it says so on submit (`components/landing/early-access-form.tsx:53`). The landing page doesn't overclaim: publishing and measurement are labeled unavailable (`app/page.tsx:150`, `:349`) and mock data is labeled illustrative [V].

---

## 4. Test and build results

| Check | Command | Exit | Result |
|---|---|---|---|
| Backend typecheck | `npx tsc --noEmit` (backend) | 0 | Clean [V] |
| Frontend typecheck | `npx tsc --noEmit` (frontend) | 0 | Clean [V] |
| Frontend lint | `npx eslint` (frontend) | 0 | Clean [V] |
| Backend tests | `npx vitest run` (with user approval; writes only to `gsc_optimizer_test` and Redis db 1) | 0 | **20 files, 426 tests passed, 0 skipped, 31.2 s** [V] |
| Migration status | `./node_modules/.bin/prisma migrate status` (read-only, dev DB) | 0 | 9 migrations, "Database schema is up to date" [V] |
| Dependency audit | `npm audit --omit=dev` (backend and frontend) | 0 | 0 vulnerabilities in both [V] |
| Frontend build | `next build` | — | **Skipped** at user request (could disrupt a running dev server) [NV] |
| E2E / browser | none exist | — | [NV] |

Coverage by category:

| Category | Present? |
|---|---|
| 1. Unit tests | Yes: AI, drafts, section-body, originality, review, URL, extraction |
| 2. API integration | Yes: Supertest against the real Express app for every route group |
| 3. DB integration | Yes: real Postgres, including DB-level constraint tests (`tenant-isolation.test.ts:139`, `opportunity-api.test.ts:210`) |
| 4. External API contract | Partial: provider request/response shapes against stubbed `fetch`, plus a fake GSC client |
| 5. Real-provider smoke | **None.** Google OAuth/GSC, OpenRouter and Gemini have never been exercised by an automated test |
| 6. E2E user workflow | **None** in a browser. Backend flows are chained in integration tests |
| 7. Production operational | **None** |

---

## 5. End-to-end journeys

| Journey | Works end to end? | Where it stops / gaps |
|---|---|---|
| 1. First-time user | **Yes**, with the fake Google client. Register → OWNER org → project → website → GSC connect → property map (`auth.routes`, `projects.routes`, `gsc.routes`) | Real OAuth [NV]. No invites, password reset or email verification. Any public site can be added (SEC-02) |
| 2. Find an opportunity | **Yes.** Sync → (auto) detection after sync; manual crawl → opportunities with evidence (`gsc.worker.ts` → `opportunityService.requestDetection`) | Crawl isn't automatic. Pages must be crawled before detection matches them. No scheduled sync |
| 3. Generate and review | **Yes**, with the fake AI. Analyze → validated recommendations and drafts → edit / draft / originality → proposal → approve or reject | Real model output quality [NV]. Drafts are synchronous HTTP (AI-01) |
| 4. Apply a change | **No.** Stops at `OptimizationProposal.status = APPROVED` | CORE-01 |
| 5. Measure results | **No** | CORE-02 |

The pieces work **together** up to approval. Nothing after approval exists.

---

## 6. Security findings

| ID | Sev | Finding | Evidence | Tag |
|---|---|---|---|---|
| SEC-01 | **High** | Access JWT and refresh token are logged. `pino-http` logs `res.headers` (via `getHeaders()`) for every request, and the redact list doesn't include `res.headers["set-cookie"]`. Every register/login/refresh writes live credentials to logs at `info` level outside tests | `backend/src/app.ts:25`, `backend/src/utils/logger.ts:5`, `node_modules/pino-std-serializers/lib/res.js:38` | V (static); not reproduced at runtime |
| SEC-02 | Medium | No website ownership verification before crawling. Any registered user can add any public site and crawl up to 500 pages, 2 at a time, using this server as a crawler | `services/website/website.service.ts:18` (only URL normalization); `POST /websites/:id/crawl` needs only EDITOR | V |
| SEC-03 | Medium | Per-IP rate limits (`globalLimiter`, `authLimiter`) depend on `trust proxy = 1`. If the API port is reachable directly, a client-supplied `X-Forwarded-For` sets `req.ip`, which bypasses login brute-force limits | `app.ts:21` | I (deployment-dependent) |
| SEC-04 | Low | Crawled third-party page text goes into LLM prompts. Prompt injection could steer recommendations. Mitigated by schema validation, grounding checks and mandatory human review, but there's no explicit delimiting or injection test | `services/ai/ai-context.builder.ts`, `prompts/*` | I |
| SEC-05 | Low | IPv6 transition ranges `2002::/16` (6to4) and `2001::/32` (Teredo) aren't in the blocklist and can embed private IPv4 addresses | `services/crawler/ip-policy.ts:24-34` | V |
| SEC-06 | Low | Access JWTs stay valid for up to 15 minutes after logout or role removal (stateless). Role changes do take effect immediately, because roles are re-read per request | `auth.middleware.ts` | V |

Verified as sound: SQL is always parameterized (`Prisma.sql` tagged templates); CSRF; CORS restricted to one origin; 1 MB body limit; helmet; secrets encrypted at rest; `updateSecretEnc` never returned (`toWebsiteDto`); OAuth state is signed, single-use and session-bound; 404 rather than 403 for other tenants; logger redacts request auth headers and API keys.

---

## 7. Database and migration findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| LIFE-01 | Medium | Once a proposal is approved, the opportunity moves to `PROPOSED`. Nothing ever moves it on, and the detector skips non-refreshable rows, so that (page, type) is **never detected again** and the opportunity list fills with permanently "open" items | `review.service.ts:571`, `opportunity.repository.ts:168`, partial index `OptimizationOpportunity_open_page_type_key` |
| GSC-01 | Medium | Remapping a website to a different GSC property resets `lastSyncedDate` but keeps every old analytics row under the same `propertyId`. Days the new sync doesn't overwrite stay from the old property, so metrics mix two properties | `repositories/gsc.repository.ts:78-87` |
| GSC-02 | Medium | Disconnecting GSC cascade-deletes all `GSCSearchAnalytics`. Once measurement exists, this destroys baselines | `services/gsc/gsc.service.ts:264` |
| DATA-01 | Low | Immutability of proposals, approvals, drafts and audit logs is enforced only in application code. There are no DB triggers or revoked UPDATE/DELETE grants, and deleting an opportunity cascades to its proposals and approvals | `schema.prisma` `OptimizationProposal.opportunity onDelete: Cascade` |
| DATA-02 | Low | Each content version stores full `rawHtml` and `renderedHtml` (up to 5 MB each) with no retention policy | `repositories/content.repository.ts:86` |
| DATA-03 | Low | Proposal, draft and originality tables carry `organizationId`/`projectId` without composite FKs (unlike Website/ContentPage/Opportunity). Their consistency relies on services | `schema.prisma` |
| MIG-01 | Info | Two early migrations drop columns (`internalLinks`, opportunity `gscMetrics/queries/signals`, proposal `affectedSections`). They're harmless if they were applied before real data existed. Only forward migrations exist, with no rollback scripts | `prisma/migrations/2026100418*`, `20261008120000_*`, `20261009090000_*` |

Fresh database: the test suite applies all 9 migrations from scratch with `migrate deploy` and passes [V]. Upgrade path: the dev DB reports up to date [V]. Deployment order: run `migrate deploy` before starting the API and worker [I].

Sound: composite tenant FKs, `Restrict` on page and page-version deletion while opportunities or proposals reference them, partial unique indexes for one open opportunity, one active AI run and one live proposal per recommendation, conditional `updateMany` transitions throughout, and serializable crawl start.

---

## 8. Architecture and maintainability

The structure is a simple, conventional routes → controllers → services → repositories layering. There's no agent framework and no unnecessary abstraction. **No rewrite is warranted.**

| ID | Sev | Problem | Smallest fix | Regression risk |
|---|---|---|---|---|
| AI-01 | Medium | `regenerateDraft` calls the model synchronously inside the HTTP request (up to `AI_TIMEOUT_MS` = 180 s). Commit `01a6990` raised the Next proxy timeout to 200 s to work around it. Duplicate clicks pay for two calls before the unique index rejects one | Queue drafts like analyses (run row + partial unique "one active draft per recommendation"), and have the UI poll | Medium: review UI flow changes |
| ARCH-01 | Low | `review.service.ts` is 800 lines (review, drafts, originality and staleness orchestration) | Extract `draft.service.ts` when AI-01 is done. Don't refactor separately | Low |
| AI-02 | Low | Analysis and recommendation free text isn't checked for invented numbers or claims (only drafts are) | Run `unsupportedClaims` on `recommendation`/`rationale` as warnings | Low: may reject more outputs |
| OPS-01 | Medium | No CI, no backend lint, no deploy artifacts (Dockerfiles), no runbook | GitHub Actions running typecheck, lint, vitest with Postgres and Redis services | None |
| OPS-02 | Medium | `/api/health` checks only Postgres. There's no Redis or worker liveness check, no metrics or tracing, no queue dashboard | Add Redis ping and worker heartbeat key; expose queue depth | Low |
| OPS-03 | Low | `Session` rows and BullMQ history are never pruned beyond counts | Periodic cleanup job | Low |
| OPS-04 | Low | No scheduled GSC sync or recrawl. Everything is manual | BullMQ repeatable job per property | Low |
| ERR-01 | Low | GSC API errors map to code `UPDATE_PROVIDER_ERROR` | `services/gsc/gsc.service.ts:36`: use a GSC-specific code | Low |
| DOC-01 | Low | README is stale (says `ANTHROPIC_API_KEY`, "Claude via AIProvider"; providers are OpenRouter/Gemini). Product name differs across 4 places | Update README and naming | None |

---

## 9. Product scope gaps

**Complete:** auth and sessions; tenant isolation; Search Console connect and sync; SSRF-safe crawler with versioning and Playwright fallback; deterministic opportunity engine with evidence; AI analysis with structured output and grounding; validated drafts, including fact-preserving body rewrites; internal-corpus originality check; two-step human approval bound to page versions, with an audit trail. An honest landing page.

**Partial:** organization management (single owner only); project/website management (no edit or delete); AI cost visibility; operations (health, observability).

**Missing (core):** Phase 7 apply and verify; Phase 8 measurement; opportunity lifecycle after approval (LIFE-01); password reset.

**Optional for a first release:** billing, member invites (needed before any multi-person team, though), external web plagiarism search, CMS-specific integrations beyond the first, scheduled jobs.

**Don't build now (scope expansion):** new-article generation, autonomous publishing without approval, multi-agent orchestration, AI-detector evasion, new opportunity types, "rank tracking".

---

## 10. Prioritized issue backlog

| ID | Pri | Sev | Summary | Files | Change | Acceptance criteria | Tests | Effort |
|---|---|---|---|---|---|---|---|---|
| SEC-01 | **P0** | High | Tokens in logs | `utils/logger.ts`, `app.ts` | Add `res.headers["set-cookie"]` to the redact list (or a custom `res` serializer without headers) | A login request's log line contains no JWT or refresh token | Unit test: logger with redact config on a mock response that has Set-Cookie | S |
| SEC-03 | P0 (at deploy) | Medium | XFF spoofing of rate limits | `app.ts`, deploy docs | Make `TRUST_PROXY` configurable; never expose :4000 publicly; document it | Direct request with a forged XFF is still limited | Supertest with forged header | S |
| CORE-01 | **P1** | High | No apply / verify | new `services/apply/*`, routes, worker, UI | See §12 | §12 | §12 | L |
| LIFE-01 | **P1** | Medium | `PROPOSED` dead end | `review.service.ts`, `opportunity.repository.ts` | Defined transitions out of `PROPOSED` (apply → `APPLIED`; abandon → `REJECTED`/`DISMISSED`) | Opportunity leaves `PROPOSED` and the page/type can be re-detected after its terminal state | integration | S (with CORE-01) |
| CORE-02 | P1 | High | No measurement | new `services/measurement/*` | Baseline at apply; POST window after N final days; `dataComplete`; limitations text | Report shows before/after with explicit correlation caveat | integration with fake GSC data | L |
| GSC-01 | P2 | Medium | Mixed property data | `gsc.repository.ts:78` | Delete the property's analytics when `siteUrl` changes, in the same transaction | No pre-switch rows remain after remap | integration | S |
| GSC-02 | P2 | Medium | Disconnect deletes history | `gsc.service.ts:264`, schema | Soft-disconnect (keep analytics, drop token), with explicit "delete data" separate | Analytics survive disconnect | integration | M |
| SEC-02 | P2 | Medium | Crawl any site | `website.service.ts`, crawl service | Require a mapped verified GSC property (or a DNS/meta token) before crawling more than N pages | Unverified site crawl is limited or refused | integration | M |
| AI-01 | P2 | Medium | Synchronous drafts | `review.service.ts:647`, queue, UI | Queue drafts | No request is held more than 5 s; duplicate click doesn't double-bill | integration | M |
| OPS-01 | P2 | Medium | No CI | `.github/workflows` | typecheck, lint, test | PRs gated | — | S |
| OPS-02 | P2 | Medium | Health and observability | `app.ts`, `worker.ts` | Redis and worker checks, queue metrics | Health fails when Redis is down | integration | S |
| REV-01 | P2 | Medium | No separation of duties | `review.service.ts` | Optional per-project setting: proposal approver ≠ creator | Self-approval refused when enabled | integration | S |
| SAAS-01 | P2 | Medium | No invites, roles or password reset | auth, org modules | Invite by email link; role change; reset flow | — | integration | L |
| REV-02 | P3 | Low | Version check outside tx | `review.service.ts:547-563` | Add `currentVersionId` guard to the tx (or rely on the Phase 7 recheck, documented) | — | unit | S |
| SEC-05 | P3 | Low | IPv6 6to4/Teredo | `ip-policy.ts` | Block or decode the embedded IPv4 | — | unit | S |
| AI-02, ERR-01, DOC-01, OPS-03, OPS-04, DATA-01/02/03, SEC-04, SEC-06 | P3–P4 | Low | See §6–§8 | — | — | — | — | S–M |

---

## 11. Proposed roadmap

| Phase | Contents | Why this order |
|---|---|---|
| **0: Hotfix** (S) | SEC-01, SEC-03 config, DOC-01 README | Credential exposure first; trivial |
| **7a: Apply and verify** (L) | CORE-01 manual apply + recrawl verification, LIFE-01, GSC-01, single-page recrawl | Closes the loop with no write credentials and works for every CMS |
| **8: Measurement** (L) | CORE-02, GSC-02 soft-disconnect, scheduled GSC sync (OPS-04) | Needs Phase 7a's applied runs and baselines |
| **9: Hardening** (M) | OPS-01 CI, OPS-02 health, AI-01 queued drafts, SEC-02 site verification, real-provider smoke tests (opt-in, manual), Playwright E2E for the happy path | Needed before external users |
| **10: Team and SaaS** (L) | SAAS-01 invites, roles, password reset, REV-01 | Before multi-user customers |
| **7b: Automated push** (L, optional) | Site Update API (HMAC, `updateEndpointUrl` already modeled) or first CMS integration, with dry-run, pre-update snapshot, idempotency key, rollback | Only after 7a proves the verify path that push will also depend on |

---

## 12. Recommended next phase: Phase 7a, "Apply-and-verify"

**Current verified status:** proposals can be approved and are bound to the analyzed page version. Nothing exists after that.

**Why this one:** it's the smallest change that makes the core workflow complete and measurable. It writes nothing to customer sites, so it carries no publishing risk and needs no credential handling, and it builds the verification step that any later automated publisher would need anyway.

**In scope**
1. Fix SEC-01 first, as a separate commit.
2. `POST …/proposals/:proposalId/mark-applied` (EDITOR+). Allowed only when the proposal is `APPROVED`, its `OptimizationApproval.proposalHash` still matches `proposalHash(proposal)`, and the opportunity isn't terminal. It creates an `OptimizationRun` (`status APPLYING`, `previousVersionId = approvedAgainstVersionId`) and moves the opportunity to `APPLYING`, in one transaction, idempotent through the existing `OptimizationRun.proposalId @unique`.
3. Single-page recrawl job (reusing `CrawlRun.processUrl` logic and `safeFetch`; SSRF rules unchanged).
4. Deterministic verification. The new current version's field (title / meta / H1 / section heading / section text, using the same normalization as `buildProposalValues`) must equal `proposedValue`.
   - Match: run `APPLIED`, `newVersionId` set, proposal `APPLIED`, opportunity `APPLIED`.
   - Unchanged after the user retries: stays `APPLYING`, with a clear message.
   - Different from both the old and proposed values: `FAILED` with `CONTENT_CONFLICT`. Never overwrite anything.
5. Capture a `BASELINE` `OptimizationMeasurement` from stored GSC data for the window before the apply date (no new GSC calls).
6. Lifecycle (LIFE-01): `APPLIED` is the hand-off to Phase 8. Add an "abandon proposal" action (`PROPOSED` → `REJECTED`, proposals superseded) so nothing is stuck.
7. GSC-01 fix (small, same area of data integrity).
8. UI: on an approved proposal, show "Copy value", "I've applied this", verification state, and the baseline numbers.

**Explicitly excluded:** writing to customer websites, the Site Update API, WordPress or any CMS integration, POST-window measurement and reports (Phase 8), new opportunity types, new AI features, billing, invites.

**Schema changes (one additive migration):** add `MANUAL` to `UpdateProviderType` (or add `OptimizationRun.method`); add `verifiedAt`, `verificationError` to `OptimizationRun`. Allow `previousVersionId` to reference a `CRAWL` version (it's already a plain string). No destructive changes.

**Security and compatibility:** the tenant-scoped repository pattern on every new query; EDITOR minimum; audit events `proposal.marked_applied`, `apply.verified`, `apply.verification_failed`, `opportunity.abandoned`; existing approval and staleness checks untouched; existing proposals and tests unaffected.

**Acceptance criteria**
- Only an `APPROVED`, hash-intact proposal can be marked applied. Superseded, rejected or edited-after-approval proposals return 409.
- Marking it applied twice creates exactly one run.
- Verification succeeds only on an exact normalized match in a new crawl version, and a mismatch never changes stored content.
- The opportunity reaches `APPLIED` (or can be abandoned). The detector can create a new opportunity for that page/type once the old one is terminal.
- The baseline row records its window, its metrics and whether the data was complete.
- No request or log line contains tokens (SEC-01).

**Automated tests:** integration tests (fixture site served with the updated title, the old title, and a third value; cross-tenant 404; VIEWER 403; idempotency race with two parallel requests; proposal hash tamper → 409); unit tests for field extraction and normalization parity with `buildProposalValues`; a logger redaction unit test.

**Manual smoke test:** connect a real test property → crawl → analyze → approve a title proposal → change the title on a staging page → "I've applied this" → verify it reaches `APPLIED` and the baseline appears → revert the page, then repeat with a different title to see `FAILED`/`CONTENT_CONFLICT`.

**Rollback:** the migration is additive (enum value and nullable columns), so the code can be reverted without a DB rollback. Runs left in `APPLYING` are harmless and can be swept like interrupted crawls.

---

## 13. Unknowns and unverified items

- Real Google OAuth consent, token refresh, Search Console quotas, and `dataState: 'final'` behavior on large properties **[NV]**: only the fake client was tested.
- Real OpenRouter and Gemini output quality, refusal rates, structured-output compatibility of the configured `AI_MODEL`, and cost per analysis **[NV]**.
- Frontend production build, responsive layout, accessibility, browser E2E **[NV]**.
- Behavior under production deployment (reverse proxy, TLS, cookie `Secure`, cross-subdomain OAuth callback: the callback is served by the API origin and relies on the access cookie reaching it) **[NV]**.
- SEC-01 was confirmed from library source and config, not by capturing a live log line **[I→V static]**.
- Backups, restore and data retention: nothing in the repository **[V absent]**.

---

## 14. Commands run

| # | Command | Exit | Notes |
|---|---|---|---|
| 1 | `git ls-files` and reading files (`cat`, `sed`, `grep`, `wc`) | 0 | Read-only |
| 2 | `npx tsc --noEmit` (backend) | 0 | — |
| 3 | `npx tsc --noEmit`, `npx eslint` (frontend) | 0, 0 | — |
| 4 | `npx prisma migrate status` | 2 | **Side effect:** `npx` didn't resolve the local CLI in that shell and fetched `prisma@8.0.0-rc.23` into the global npx cache. The command failed (unknown subcommand). No project files, `node_modules` or databases were changed (`git status` clean afterwards) |
| 5 | `./node_modules/.bin/prisma migrate status` | 0 | Read-only, dev DB: up to date |
| 6 | `npm audit --omit=dev` (backend, frontend) | 0 | 0 vulnerabilities each |
| 7 | `docker ps` | 0 | Postgres and Redis containers healthy |
| 8 | `npx vitest run` (backend) | 0 | **With user approval.** Ran `migrate deploy` on `gsc_optimizer_test`, truncated test tables, used Redis db 1. 426/426 passed |
| — | `next build` | — | Skipped at user request |

No commits, pushes, migrations on the dev DB, seeds, dependency installs or external calls were made, apart from the npm registry lookups in #4 and #6.
