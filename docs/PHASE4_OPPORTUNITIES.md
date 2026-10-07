# Phase 4: Opportunity Engine

Finds **existing** crawled pages that show a measurable SEO opportunity in stored Search Console data, scores them, and records the evidence. It never generates content, never modifies pages, and never calls an LLM. The same stored data and configuration always give the same result.

## 1. Flow

```
GSC sync job completes ─┐
POST …/opportunities/detect ─┴▶ OpportunityDetectionRun(QUEUED) ─▶ BullMQ opportunity-detect ─▶ worker
worker, per website with synced GSC data:
  pageAggregates (SQL, batches of 200) ──▶ queriesForPages (SQL, same batch)
  ──▶ detectPageOpportunities (pure) ──▶ upsertDetected ──▶ clearStale
```

The GSC worker queues a detection run after every successful sync. If a detection run is still waiting in the queue, new requests reuse it, because a queued run reads the latest data when it starts.

## 2. Module layout

```
services/optimization/
  opportunity.config.ts            every threshold, weight and the expected-CTR curve (env overrides)
  opportunity.types.ts             PageInput, Evidence, DetectedOpportunity, …
  opportunity-query.service.ts     GSC-correct aggregation helpers, query ranking, term coverage
  opportunity-scoring.service.ts   normalized components × per-type weights → 0–100
  opportunity-evidence.service.ts  measurable facts with thresholds + neutral text
  opportunity-detector.service.ts  rules (RULES), detectPageOpportunities (pure), runDetection (batched run)
  opportunity.service.ts           API: list / get / detect / dismiss
repositories/opportunity.repository.ts   SQL aggregation, dedup-aware upsert, runs
queues/opportunity.queue.ts, workers/opportunity.worker.ts
```

## 3. Data and aggregation

- **Page totals** come from the page-only GSC rows (`query = ''`). The query rows under-report because GSC anonymizes some queries, so page totals are never built by summing them.
- **Aggregation semantics:** clicks and impressions are summed. CTR is recomputed as clicks ÷ impressions, never averaged across days. Position is weighted by impressions.
- One SQL scan computes the current and previous windows for each page, using `FILTER` clauses. It is joined to `ContentPage` with `websiteId` and tenant keys and `status = 'ACTIVE'`. GSC URLs that were never crawled, belong to another host, or are now gone/redirected/excluded are dropped at this point.
- **Windows:** the current window is the `windowDays` (28) days ending at the earlier of the property's `lastSyncedDate` and the latest final GSC day. The previous window is the 28 days before that.
- **Indexes:** partial indexes on `GSCSearchAnalytics`, one for page totals `(propertyId, date, page) INCLUDE (clicks, impressions, position) WHERE query = ''` and one for query rows `(propertyId, page, date) WHERE query <> ''`. Opportunities have `(organizationId, projectId, status, score DESC)`.

## 4. Opportunity types

A page is only evaluated when it has at least `minImpressions` (200) impressions in either window.

| Type | Fires when | Primary evidence |
|---|---|---|
| `LOW_CTR` | impressions ≥ 500, position ≤ 20, CTR < 60% of the expected CTR for its position | `LOW_CTR` |
| `PAGE_ONE_NEAR_TOP` | position between 4 and 10, impressions ≥ 300 | `PAGE_ONE_RANKING` |
| `HIGH_IMPRESSIONS_LOW_CLICKS` | impressions ≥ 5,000 and absolute CTR < 1.5% (applies at any position) | `HIGH_IMPRESSIONS`, `LOW_CTR` (absolute) |
| `PERFORMANCE_DECLINE` | clicks down ≥ 25% (previous ≥ 50 clicks) **or** CTR down ≥ 25% (previous ≥ 1,000 impressions) | `CLICK_DECLINE`, `CTR_DECLINE` |
| `CONTENT_COVERAGE_SIGNAL` | one of the top 5 queries with ≥ 100 impressions has fewer than half of its terms in the title, H1 or headings | `CONTENT_COVERAGE_SIGNAL` (per query, with missing terms) |

Supporting evidence attached when it holds: `HIGH_QUERY_IMPRESSIONS`, `QUERY_CONCENTRATION`, `POSITION_CHANGE`, and the other facts listed above.

The coverage check is lexical. It lowercases, removes accents and stopwords, applies light suffix stemming, and treats terms as matching when they share a 5-character prefix ("optimization" ≈ "optimize"). It only says the page *may* not cover the query in a dedicated section. Phase 5 does the semantic analysis.

## 5. Scoring

Each component is normalized to the range 0–1:

| Component | Meaning |
|---|---|
| impressions | log scale from `minImpressions` (0) to 100,000 (1) |
| ctr | (expected − actual) ÷ expected CTR at the page's position |
| position | 1 at position 4, falling to 0.7 at 10 and to 0 at 20. Positions 1–3 score 0.3 because there is less room to move up. |
| trend | the larger of the click decline and the CTR decline, divided by 60% |
| query | share of query impressions from queries ranking 4–20 |
| coverage | share of query impressions from uncovered queries, divided by 50% |

`score = Σ weight × component`. Each type has its own weight row summing to 100. For example, `LOW_CTR` weights are ctr 35, impressions 25, position 20, trend 10, query 10. The full breakdown (`{component, value, weight, points}`) is stored and shown in the UI. Listing order is score, then impressions, then clicks.

## 6. Deduplication (decision)

**One non-terminal opportunity per (page, type), refreshed in place.** We chose this over snapshots per evaluation window.

- A partial unique index on `(pageId, type) WHERE status NOT IN (COMPLETED, REJECTED, FAILED, DISMISSED)` enforces it in the database. A concurrent duplicate insert hits the index and is retried as an update.
- Re-detection updates a `DETECTED`/`REVIEWED` row: same id, new window, metrics, score and evidence, plus `lastDetectedAt` and `detectionRunId`.
- Rows already in the AI/approval pipeline (`ANALYZING` and later) are left untouched, so a proposal never sees its evidence change underneath it.
- If a run no longer detects a `DETECTED` row's signal, the row becomes `DISMISSED` with `dismissReason = SIGNAL_CLEARED`.
- A user dismissal suppresses the same (page, type) for `dismissSnoozeDays` (28).
- History lives in the audit log (`opportunity.detection_completed` with per-run counts) and in `OpportunityDetectionRun`.

Why: users see one row per issue rather than a growing list per sync. Phase 5+ can safely point at a stable opportunity id.

## 7. Existing-page guarantee

1. The SQL join only produces pages that exist in `ContentPage` for this website with `status = ACTIVE`.
2. `pageId` is `NOT NULL`, with a composite FK `(pageId, websiteId, projectId, organizationId) → ContentPage`. An opportunity for a missing page, or for a page in another website/project/tenant, cannot be inserted.

## 8. API

| Route | Role | Notes |
|---|---|---|
| GET `/api/projects/:projectId/optimization/opportunities?status=open\|dismissed\|all&type&websiteId&limit&offset` | VIEWER | `{items, total, latestRun}`. Each item has `reasons[]` (primary evidence text). |
| GET `…/opportunities/:id` | VIEWER | page, metrics (current/previous/summary), topQueries, scoreBreakdown, evidence |
| POST `…/opportunities/detect` (alias `…/recalculate`) | EDITOR | `202` DetectionRun. `400` if no GSC data has been synced yet. |
| POST `…/opportunities/:id/dismiss` | EDITOR | `{reason?}`. `409` unless status is DETECTED/REVIEWED. Audited. |

All routes use `requireAuth` and `requireProjectAccess`. Every query filters by `organizationId` + `projectId`. Ids from another tenant return 404.

## 9. Configuration

Env overrides, with defaults: `OPPORTUNITY_WINDOW_DAYS=28`, `OPPORTUNITY_MIN_IMPRESSIONS=200`, `OPPORTUNITY_LOW_CTR_RATIO=0.6`, `OPPORTUNITY_LOW_CTR_MAX_POSITION=20`, `OPPORTUNITY_LOW_CTR_MIN_IMPRESSIONS=500`, `OPPORTUNITY_PAGE_ONE_MIN_POSITION=4`, `OPPORTUNITY_PAGE_ONE_MAX_POSITION=10`, `OPPORTUNITY_PAGE_ONE_MIN_IMPRESSIONS=300`, `OPPORTUNITY_HIGH_IMPRESSIONS=5000`, `OPPORTUNITY_HIGH_IMPRESSIONS_MAX_CTR=0.015`, `OPPORTUNITY_MIN_DECLINE_PERCENT=25`, `OPPORTUNITY_MIN_QUERY_IMPRESSIONS=100`. The rest (weights, curve, coverage, snooze, batch size) live in `opportunity.config.ts`. Each run stores a snapshot of the config it used.

The defaults suit sites with a few thousand monthly impressions or more. On a small site, lower `OPPORTUNITY_MIN_IMPRESSIONS`, `…_LOW_CTR_MIN_IMPRESSIONS`, `…_PAGE_ONE_MIN_IMPRESSIONS` and `…_MIN_QUERY_IMPRESSIONS`.

## 10. Language

Evidence text states measurements and thresholds only. A test asserts that it never uses causal or promissory wording ("because", "will increase", …). The UI adds: *"This describes measured Search Console performance… It does not establish a cause or predict the effect of changes."*

## 11. Tests

- `test/opportunity-engine.test.ts`: pure unit tests covering aggregation, weighting, ranking, every signal, coverage, scoring, evidence, config and determinism.
- `test/opportunity-api.test.ts`: integration tests against Postgres and Redis covering SQL aggregation, fixture pages A–D, the existing-page and FK guarantees, dedup and refresh, clearing, snooze, pipeline-state protection, ranking, detail, dismiss, tenant isolation, roles, GSC sync → detection through real workers, failed job, and double processing.
- Fixtures: `test/opportunity-fixtures.ts`.
