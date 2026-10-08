# Phase 5: AI Analysis & Recommendation

For a Phase 4 opportunity, Claude explains what the stored evidence shows, what the page covers, the search intent behind its queries, observable content gaps, and changes a human might consider. Phase 5 never modifies or publishes content and never changes the opportunity's status. Its output is input for Phase 6 (human approval).

## Flow

```
POST …/opportunities/:id/analyze  (EDITOR, 202)
  → AIAnalysisRun QUEUED → BullMQ "ai-analysis" (jobId = runId)
worker: RUNNING → buildAIContext (fresh, tenant-scoped)
  → AIProvider.analyzeOpportunity   (prompt opportunity-analysis-v1)  → Zod + grounding checks
  → AIProvider.generateRecommendation (prompt recommendation-v1)    → Zod + grounding checks
  → OpportunityAnalysis row + run COMPLETED (one transaction)
GET …/opportunities/:id/analysis (VIEWER) → { latestRun, analysis | null }
```

## Architecture

```
services/ai/
  ai.provider.ts          AIProvider interface (analyzeOpportunity, generateRecommendation) + aiProvider()/setAIProvider()
  anthropic.provider.ts   the only file importing @anthropic-ai/sdk: request construction, structured outputs, error mapping, usage
  ai.config.ts            env → AIConfig; AINotConfiguredError
  ai.errors.ts            AIError {code, retryable, usage}
  ai.schemas.ts           Zod: OpportunityAnalysis, Observation, Interpretation, SearchIntent, ContentGap, Recommendation, RecommendationSet
  ai.guardrails.ts        grounding checks on schema-valid output
  ai-context.builder.ts   AIContext from stored data (CONTEXT_VERSION = opportunity-context-v1)
  prompts/                versioned prompt files (shared-rules, opportunity-analysis-v1, recommendation-v1)
  opportunity-analysis.service.ts   request / get / runAIAnalysis
repositories/ai-analysis.repository.ts, queues/ai-analysis.queue.ts, workers/ai-analysis.worker.ts
```

Application code depends only on `AIProvider`. To add another provider, implement the interface and select it in `aiProvider()`.

**Anthropic request:** `client.beta.messages.parse` with `output_config: { effort, format: betaZodOutputFormat(schema) }`. Adaptive thinking is the model default. With `AI_REFUSAL_FALLBACK=true`, the request also sends `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a safety-classifier decline is re-run on Anthropic's recommended fallback model. Disable this for models or platforms that don't support it. The SDK handles timeouts (`AI_TIMEOUT_MS`) and transport retries (`AI_MAX_RETRIES`).

## Validation: invalid output is never stored as a success

1. **Zod re-validation** of `parsed_output`, which also checks limits the structured-output schema can't express (confidence 0–1, at least one evidence item, list sizes).
2. **Grounding checks** (`ai.guardrails.ts`):
   - Every intent or gap query must exist in the opportunity's GSC queries.
   - Every `targetSection` must be a real `sectionKey`.
   - With no crawled content, the model must report `evidenceSufficient: false` and must not list content gaps.
   - Promissory or certain-causal wording is rejected: "will increase", "guarantee", "definitely", "this is the reason".
3. **Stop reasons:** `refusal` → `AI_REFUSED`; `max_tokens` → `AI_TRUNCATED`.

Any failure marks the run `FAILED` with an `errorCode`, raises `UnrecoverableError`, and is not retried.

## Retries

| Error | Code | Behavior |
|---|---|---|
| 429, 5xx/529, connection/timeout | `PROVIDER_RETRYABLE` | SDK retries first, then BullMQ (3 attempts, exponential backoff from 30 s). The run stays `RUNNING` with the last error recorded. Exhausted retries → `FAILED`. |
| 400/401/403, other 4xx | `PROVIDER_ERROR` | fail at once |
| invalid / ungrounded output | `AI_OUTPUT_INVALID` | fail at once (no retry) |
| refusal / truncation | `AI_REFUSED` / `AI_TRUNCATED` | fail at once |
| opportunity dismissed or deleted after queuing | `CONTEXT_UNAVAILABLE` | fail at once, before any AI call |

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

`ANTHROPIC_API_KEY`, `AI_MODEL` (e.g. `claude-opus-5-5`; no default in code), `AI_MAX_TOKENS=16000`, `AI_TIMEOUT_MS=180000`, `AI_MAX_RETRIES=2`, `AI_EFFORT=high`, `AI_REFUSAL_FALLBACK=true`.

The app starts without the first two: analyze returns 503 and the worker logs a warning. The key is never logged (logger redacts `*.apiKey` and `x-api-key`) and never included in error messages.

## Tests

- `test/ai-unit.test.ts`: config, prompt versions, schemas, guardrails, and AnthropicProvider against a mocked SDK client (request shape, usage, invalid output, refusal, truncation, error classification).
- `test/ai-analysis.test.ts`: context building, truncation, missing content, cross-tenant context; lifecycle, duplicates, invalid/ungrounded output, retryable then success, permanent failure, dismissed-after-queue, 409/503; BullMQ worker success and no retry on invalid output; 404 cross-tenant, 401, viewer 403.
- Tests never call Claude. `test/setup-env.ts` clears the AI env vars and pins the Phase 4 thresholds so a local `.env` can't affect results.
