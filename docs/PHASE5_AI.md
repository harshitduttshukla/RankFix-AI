# Phase 5: AI Analysis & Recommendation

For a Phase 4 opportunity, the configured model (via OpenRouter) explains what the stored evidence shows, what the page covers, the search intent behind its queries, observable content gaps, and changes a human might consider. Phase 5 never modifies or publishes content and never changes the opportunity's status. Its output is input for Phase 6 (human approval).

## Flow

```
POST …/opportunities/:id/analyze  (EDITOR, 202)
  → AIAnalysisRun QUEUED → BullMQ "ai-analysis" (jobId = runId)
worker: RUNNING → buildAIContext (fresh, tenant-scoped)
  → AIProvider.analyzeOpportunity   (prompt opportunity-analysis-v1)  → Zod + grounding checks
  → AIProvider.generateRecommendation (prompt recommendation-v2)    → Zod + grounding checks
  → sanitizeDrafts (drafts.ts): invalid drafts dropped, reasons kept in draftIssues
  → OpportunityAnalysis row + run COMPLETED (one transaction)
GET …/opportunities/:id/analysis (VIEWER) → { latestRun, analysis | null }
```

## Architecture

```
services/ai/
  ai.provider.ts          AIProvider interface (analyzeOpportunity, generateRecommendation) + aiProvider()/setAIProvider()
  openrouter.provider.ts  the only file that talks to the AI API: OpenRouter Chat Completions over fetch, strict JSON-schema output, error mapping, usage, transient retries
  ai.config.ts            env → AIConfig; AINotConfiguredError
  ai.errors.ts            AIError {code, retryable, usage}
  ai.schemas.ts           Zod: OpportunityAnalysis, Observation, Interpretation, SearchIntent, ContentGap, Recommendation, RecommendationSet
  ai.guardrails.ts        grounding checks on schema-valid output
  ai-context.builder.ts   AIContext from stored data (CONTEXT_VERSION = opportunity-context-v1)
  prompts/                versioned prompt files (shared-rules, opportunity-analysis-v1, recommendation-v2, draft-v1)
  drafts.ts               draft targets, limits and validation for AI-drafted replacement copy
  opportunity-analysis.service.ts   request / get / runAIAnalysis
repositories/ai-analysis.repository.ts, queues/ai-analysis.queue.ts, workers/ai-analysis.worker.ts
```

Application code depends only on `AIProvider`. To add another provider, implement the interface and select it in `aiProvider()`.

**OpenRouter request** (`POST {OPENROUTER_BASE_URL}/chat/completions`, `Authorization: Bearer OPENROUTER_API_KEY`):
- **Body:** `model = AI_MODEL`, system + user messages (the same versioned prompts), `max_tokens`.
- **Structured output:** `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`. The schema is generated from the Zod schemas with length and range keywords stripped for strict-mode compatibility; Zod still enforces those on re-validation.
- **Routing:** `provider.require_parameters: true`, so OpenRouter only routes to endpoints of that model that support structured output. There is no model fallback list, so the configured model is always the one used.
- **Reasoning:** `reasoning: {effort, exclude: true}` only when `AI_REASONING_EFFORT` is set.
- **Removed Anthropic features:** adaptive thinking parameters, the `fallbacks` refusal beta and the SDK error classes are gone. Their application-level counterparts (refusal → `AI_REFUSED`, no retry; Zod; grounding) remain.

Choose an `AI_MODEL` whose OpenRouter page lists `structured_outputs`; otherwise requests fail with `AI_MODEL_NOT_FOUND`.

## Validation: invalid output is never stored as a success

1. **Zod re-validation** of `parsed_output`, which also checks limits the structured-output schema can't express (confidence 0–1, at least one evidence item, list sizes).
2. **Grounding checks** (`ai.guardrails.ts`):
   - Every intent or gap query must exist in the opportunity's GSC queries.
   - Every `targetSection` must be a real `sectionKey`.
   - With no crawled content, the model must report `evidenceSufficient: false` and must not list content gaps.
   - Promissory or certain-causal wording is rejected: "will increase", "guarantee", "definitely", "this is the reason".
3. **Stop reasons:** `refusal` → `AI_REFUSED`; `max_tokens` → `AI_TRUNCATED`.

Any failure marks the run `FAILED` with an `errorCode`, raises `UnrecoverableError`, and is not retried.

## AI drafts (`suggestedValue`, recommendation-v2)

Each recommendation carries `suggestedValue`: concrete replacement copy, or `null`. Drafts are allowed only for these types:

| Recommendation | Replaces | Default max length |
|---|---|---|
| `TITLE` | title | 70 (`AI_DRAFT_MAX_TITLE`) |
| `META_DESCRIPTION` | meta description | 160 (`AI_DRAFT_MAX_META_DESCRIPTION`) |
| `HEADING`, no `targetSection` | H1 | 90 (`AI_DRAFT_MAX_H1`) |
| `HEADING` with `targetSection` | that section's heading | 90 (`AI_DRAFT_MAX_SECTION_HEADING`) |
| `INTRODUCTION` | intro section text, only when `targetSection` is the page's first section and it has no heading | 1200 (`AI_DRAFT_MAX_INTRODUCTION`) |

`checkDraft` (`drafts.ts`) rejects a draft when any of these hold:
- the type may not carry a draft
- it is empty, longer than its limit or shorter than its minimum
- a single-line field spans several lines, or it contains markup or links
- it is identical to the current value
- it uses the shared overclaim wording (negated "not guaranteed" disclaimers still pass)
- it contains an **unsupported claim**: a number, price, rate, offer, credential or superlative term, or a capitalized name or place, that isn't in the page's own text. Names may also come from its GSC queries. A query asking for a price never makes a price claim acceptable.

During analysis, an invalid draft is dropped: the recommendation is kept, `suggestedValue` becomes `null`, and the reasons go in `draftIssues`. The run still fails on overclaim wording anywhere, drafts included, exactly as before.

A reviewer can request a new draft (Phase 6, `POST …/recommendations/:id/draft`, prompt `draft-v1`, `AIProvider.generateDraft`). The result goes through the same checks. Valid drafts are stored as a new `RecommendationDraft` revision; invalid, empty or repeated ones are discarded and audited as `recommendation.draft_failed`. `AI_DRAFT_MAX_REGENERATIONS` (default 5) caps requests per recommendation.

The checks are deterministic and deliberately strict. A false positive only means the reviewer writes the copy themselves.

## Body-section drafts (`section-body-v1`)

These are rewrites of one existing section's body text, for `CLARIFICATION` and `SECTION_EXPANSION` recommendations that target an existing section with text.
- `MISSING_TOPIC` is excluded, because covering a new topic needs new facts.
- Body drafts are generated **only when a reviewer requests one**: `POST …/recommendations/:id/draft` calls `AIProvider.generateSectionBody`. The analysis never produces them; `sanitizeDrafts` drops any body draft it returns.
- Every other draft type behaves exactly as before.

A body draft goes through every existing draft check: schema, unsupported claims, overclaim wording, identical-to-current and plain text. It also goes through `section-body.ts`:

| Check | Rule (default) |
|---|---|
| Size | 15 to 800 words (`AI_BODY_MIN_WORDS`, `AI_BODY_MAX_WORDS`), at most 8 paragraphs |
| Length vs original | at least 0.6× the original, and at most the larger of 1.5× the original or original + 25 words (`AI_BODY_*_LENGTH_RATIO`, `AI_BODY_LENGTH_SLACK_WORDS`) |
| Unrelated rewrite | word-level edit distance ≤ 0.85 of the longer text, and at least 40% of the original's content words kept |
| Material facts kept | every number and every name (capitalized, not sentence-initial) in the original must appear (`AI_BODY_MIN_FACT_PRESERVATION` = 1) |
| Caveats kept | if the original has a negation, condition, limitation or hedge ("not", "depends on", "only", "may" …), the draft must too |
| Nothing added | numbers must come from the section itself; names from the section or the page |
| Truncated sections | refused, because the full original could not be compared |

Similarity is never treated as proof of correctness. The checks are explicit and conservative, and a reviewer still reads the original and the draft side by side.

**What is stored on a `RecommendationDraft`:** `target` (`SECTION_BODY`), `sectionKey`, `sourceTextHash` (sha256 of the exact section text in the analyzed version), `validation` (passed, plus metrics), the prompt version and the revision.

**Staleness:** approving a draft whose `sourceTextHash` no longer matches the section returns 409 `ANALYSIS_STALE`. The existing page-version binding still applies.

**Failed drafts** are never stored. `recommendation.draft_failed` records the code, the issues and the metrics, never the text.

## Errors and retries

| OpenRouter result | Code | Behavior |
|---|---|---|
| 429 | `AI_RATE_LIMITED` | transient |
| 408/504, client timeout (`AI_TIMEOUT_MS`) | `AI_TIMEOUT` | transient |
| 500/502/503, network error, `finish_reason: error` | `AI_PROVIDER_UNAVAILABLE` | transient |
| 401 | `AI_AUTHENTICATION_FAILED` | permanent |
| 402 | `AI_INSUFFICIENT_CREDITS` | permanent |
| invalid model / no endpoint meeting `require_parameters` | `AI_MODEL_NOT_FOUND` | permanent |
| other 4xx | `AI_BAD_REQUEST` | permanent |
| 403 moderation/guardrail, `message.refusal`, `finish_reason: content_filter` | `AI_REFUSED` | permanent |
| `finish_reason: length` | `AI_TRUNCATED` | permanent |
| empty, non-JSON, schema-invalid or ungrounded output | `AI_OUTPUT_INVALID` | permanent |
| error object inside an HTTP 200 body | mapped by its code | as above |

Transient errors are retried inside the provider up to `AI_MAX_RETRIES` times (default 1, backoff 1 s, 2 s, …, capped at 8 s). After that, BullMQ retries the job (3 attempts, exponential from 30 s), so the worst case is (1 + `AI_MAX_RETRIES`) × 3 calls. Permanent errors fail the run once and are not retried. Error messages are our own wording, so raw provider bodies and keys never reach the database or the UI.

Worker start marks runs stuck `RUNNING` for more than 45 minutes as `FAILED` (`INTERRUPTED`).

## Context

The context is built only from this opportunity's stored data. Every query is scoped by `organizationId` + `projectId`, and the page and website are reached through the opportunity's own `websiteId` and `pageId`.

It contains:
- project name, website base URL, blog prefix
- opportunity type, score, breakdown, window, current and previous metrics, evidence, top 25 queries
- page URL, status, last crawl time
- current version: title, meta description, canonical, language, robots, H1, H1–H6 outline, sections, internal in-content links (≤ 40), JSON-LD types, count of images missing alt text

Tenant IDs are not included. Section text is capped at 4,000 characters per section and 40,000 in total; truncation is flagged in the context (`truncated`, `contentTruncated`) rather than done silently. The prompts tell the model that page content is untrusted data and that instructions inside it must be ignored.

## Data model

- `AIAnalysisRun`: `organizationId, projectId, websiteId, opportunityId, requestedById, provider, model, promptVersion, contextVersion, status (QUEUED/RUNNING/COMPLETED/FAILED), attempts, startedAt, completedAt, latencyMs, inputTokens, outputTokens, errorCode, errorMessage`. A partial unique index allows only one QUEUED/RUNNING run per opportunity, so duplicate requests return the active run. Prompts, responses and secrets are not stored on the run.
- `OpportunityAnalysis`: one per successful run. Stores `analysis` JSON, `recommendations` JSON, `pageVersionId` (the content version analyzed), provider/model/prompt/context versions.
- Migrations: `20261008160000_ai_analysis`, `20261008160100_ai_run_active_unique`.

## API

| Route | Role | Result |
|---|---|---|
| POST `/api/projects/:projectId/optimization/opportunities/:id/analyze` | EDITOR | `202` run. `409` if the opportunity isn't DETECTED/REVIEWED. `503 AI_NOT_CONFIGURED`. Rate-limited to 60 per project per hour. |
| GET `/api/projects/:projectId/optimization/opportunities/:id/analysis` | VIEWER | `{opportunityId, latestRun, analysis}` |

Cross-tenant IDs return 404. Requests and completions are audited (`ai.analysis_requested`, `ai.analysis_completed`).

## Configuration

| Variable | Notes |
|---|---|
| `OPENROUTER_API_KEY` | Required to analyze |
| `AI_MODEL` | Required. An OpenRouter model ID such as `vendor/model`, from a model that supports structured output. No default in code. |
| `OPENROUTER_BASE_URL` | Default `https://openrouter.ai/api/v1` |
| `AI_MAX_TOKENS` | Default 16000 |
| `AI_TIMEOUT_MS` | Default 180000 |
| `AI_MAX_RETRIES` | Default 1 |
| `AI_REASONING_EFFORT` | Optional: none, minimal, low, medium, high, xhigh, max |

The app starts without the key: analyze returns 503 and the worker logs a warning. The key is sent only in the Authorization header. It is never logged (the logger redacts `*.apiKey`, `*.OPENROUTER_API_KEY` and authorization headers), never put in prompts, never stored, and never included in error messages. `ANTHROPIC_API_KEY`, `AI_EFFORT` and `AI_REFUSAL_FALLBACK` are no longer read.

## Tests

- `test/ai-unit.test.ts`: config, prompt versions, schemas, guardrails.
- `test/openrouter.test.ts`: OpenRouterProvider against mocked HTTP covering URL, auth header, model, strict schema, reasoning flag, parsing, Zod failures, malformed and missing output, refusal, truncation, error-in-200, every HTTP error class, retries, timeout, network failure, usage, and key redaction.
- Provider switch (in `ai-analysis.test.ts`): the unchanged Phase 5 pipeline completes with both FakeAI and OpenRouterProvider.
- `test/ai-analysis.test.ts`: context building, truncation, missing content, cross-tenant context; lifecycle, duplicates, invalid/ungrounded output, retryable then success, permanent failure, dismissed-after-queue, 409/503; BullMQ worker success and no retry on invalid output; 404 cross-tenant, 401, viewer 403.
- Tests never call Claude. `test/setup-env.ts` clears the AI env vars and pins the Phase 4 thresholds so a local `.env` can't affect results.
