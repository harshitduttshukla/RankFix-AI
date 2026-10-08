# Phase 6: Human Approval & Proposal Workflow

AI recommends, a human decides, the system records the decision. Phase 6 ends at a **human-approved concrete proposal bound to an exact page version**. Nothing here modifies the live website. The only AI call is an explicit re-analysis, which goes through the Phase 5 pipeline.

## State model

Three separate lifecycles, so no single field carries two meanings.

**Opportunity (workflow).** This extends the existing enum; Phase 4 detection is unchanged.
```
DETECTED ─(first edit/approve/reject of a recommendation)→ REVIEWED ─(first proposal approved)→ PROPOSED → … COMPLETED (Phase 7/8)
DETECTED → DISMISSED (Phase 4, unchanged)     REVIEWED | PROPOSED → REJECTED (explicit, with reason)
```
Phase 4 still refreshes `REVIEWED` rows in place and never touches `PROPOSED`. Only `DETECTED` rows are auto-cleared. The list's default "open" filter now also includes `PROPOSED`.

**RecommendationReview (per recommendation, per analysis).**
```
PENDING → EDITED → APPROVED | REJECTED        (PENDING → APPROVED | REJECTED directly also)
```
- **Original vs edit:** the AI original is copied into `original` and never changed. A human edit goes into `edited`, with `editedById` and `editedAt`.
- **Rejection:** stores a reason (`NOT_RELEVANT`, `INCORRECT`, `ALREADY_ADDRESSED`, `NOT_WORTH_CHANGING`, `OTHER`), an optional note, the reviewer and the time.
- **Creation:** review rows are created on first access to an analysis's review, one per recommendation, with a unique `(analysisId, index)`.

**OptimizationProposal (concrete change).**
```
AWAITING_APPROVAL → APPROVED | REJECTED ;  AWAITING_APPROVAL | APPROVED → SUPERSEDED (new revision, or opportunity rejected)
APPROVED → APPLIED | FAILED (Phase 7)
```

## Proposal lifecycle

1. **Approve a recommendation.** The reviewer sends `proposedValue`, plus optionally `changeType` and `targetSection` (defaults come from the recommendation type). In one transaction the review becomes `APPROVED` and a proposal is created in `AWAITING_APPROVAL`:
   - `pageVersionId` is the analyzed version.
   - `currentValue` is read from that version by the server, never from the client.
   - `source` is `AI_RECOMMENDATION` or `HUMAN_EDITED`.
   - The opportunity moves `DETECTED → REVIEWED` and the audit events are written.
2. **Approve the proposal.** This re-checks that the analysis is current and not stale, and that `page.currentVersionId == proposal.pageVersionId`. It then sets `APPROVED` with `approvedById`, `approvedAt` and `approvedAgainstVersionId`, and writes an `OptimizationApproval` row whose `proposalHash` is sha256 of (changeType, target, current, proposed, pageVersionId). The opportunity moves to `PROPOSED`.
3. **Different change wanted.** Source values are never edited. `POST …/proposal` creates revision n+1 (with `supersedesId`) and marks the previous live one `SUPERSEDED`.

Supported change types (V1): `TITLE`, `META_DESCRIPTION`, `H1`, `SECTION_HEADING`, `SECTION_CONTENT` (plain text for an existing `sectionKey`). Validation:
- the value must be non-empty and within per-type length limits
- it must differ from the current value
- no script, iframe or style tags
- the section must exist in the analyzed version

Recommendation types without a section (for example a `MISSING_TOPIC` with no target) need the reviewer to pick a change type and section.

**For Phase 7:** `proposalMatchesCurrentPage(scope, proposalId)` returns `{status, pageVersionId, currentVersionId, matches}`, and the review API shows `matchesCurrentPageVersion` on each proposal. Apply only `APPROVED` proposals where `matches` is true and the stored hash still equals the recomputed one.

## Stale analysis (deterministic, no AI)

The latest analysis is stale when either:
- **`PAGE_VERSION_CHANGED`:** the page's `currentVersionId` differs from the analyzed `pageVersionId`.
- **`EVIDENCE_CHANGED`:** compared with the evidence snapshot Phase 5 now stores at analysis time:
  - impressions changed by ≥ 30% (only when the snapshot had ≥ 100 impressions), or
  - clicks changed by ≥ 30% (only when the snapshot had ≥ 20 clicks), or
  - average position moved by ≥ 2.

Thresholds are in `services/review/review.config.ts`.

Staleness is persisted on first detection (`staleAt`, `staleReason`; it is sticky) and audited once as `analysis.marked_stale`.

While stale:
- recommendation approval, new proposals and proposal approval are refused with `409 ANALYSIS_STALE` ("Re-analysis required").
- the UI shows "This analysis was generated from an older version of this page."

Actions on recommendations from an older analysis are refused the same way.

**Re-analysis:** `POST …/reanalyze` creates a new `AIAnalysisRun` (concurrent duplicates collapse into the active run) and audits `analysis.reanalysis_requested` with the reason. Old analyses, reviews and proposals are kept, and the newest analysis becomes current.

## API (all under `/api/projects/:projectId/optimization/opportunities/:id`)

| Route | Role | Notes |
|---|---|---|
| GET `/review` | VIEWER | opportunity, page and current version, `analysisState` (NO_ANALYSIS/QUEUED/RUNNING/COMPLETED/FAILED/STALE), latest run, analysis, recommendations with reviews and proposals |
| PATCH `/recommendations/:recommendationId` | EDITOR | `{recommendation?, rationale?, type?, targetSection?}` |
| POST `/recommendations/:recommendationId/approve` | EDITOR | `{proposedValue, changeType?, targetSection?}` → review APPROVED + proposal |
| POST `/recommendations/:recommendationId/reject` | EDITOR | `{reason?, note?}` |
| POST `/recommendations/:recommendationId/proposal` | EDITOR | new proposal revision (201) |
| POST `/proposals/:proposalId/approve` | EDITOR | `{comment?}` |
| POST `/proposals/:proposalId/reject` | EDITOR | `{reason?}` |
| POST `/reject` | EDITOR | opportunity REVIEWED/PROPOSED → REJECTED, live proposals SUPERSEDED |
| POST `/reanalyze` | EDITOR | 202, AI rate-limited |

Every lookup is scoped by organization and project, and recommendations and proposals are also reached through the opportunity. Cross-tenant IDs return 404, viewers get 403 on writes, and unauthenticated requests get 401.

## Concurrency and atomicity

- Each multi-record change (status, proposal, approval row, opportunity status, audit events) runs in one transaction.
- Every status change is a conditional `updateMany … WHERE status IN (allowed)`. Under row locking a concurrent second writer matches 0 rows and gets 409.
- A partial unique index allows one live proposal (`AWAITING_APPROVAL`/`APPROVED`) per review.
- `OptimizationApproval.proposalId` is unique.
- If any step fails, the whole transaction rolls back. This is tested by failing the audit write.

## Audit events

| Group | Events |
|---|---|
| Opportunity | `opportunity.reviewed`, `opportunity.rejected` |
| Recommendation | `recommendation.edited`, `recommendation.approved`, `recommendation.rejected` |
| Proposal | `proposal.created`, `proposal.superseded`, `proposal.approved`, `proposal.rejected` |
| Analysis | `analysis.marked_stale`, `analysis.reanalysis_requested` |

Metadata includes websiteId, opportunityId, recommendationId and proposalId where applicable, from/to status and reason. Org, project and actor are columns on the audit row. No prompts or secrets are recorded.

## Database (migration `20261009090000_human_review`)

| Change | Details |
|---|---|
| New `RecommendationReview` | Enums `RecommendationReviewStatus`, `RecommendationRejectionReason` |
| Reshaped `OptimizationProposal` | Was an unused placeholder with no rows. Gains `ProposalChangeType` and `ProposalSource`, FK to `ContentPageVersion` (restrict), FK to the review, and a partial unique index for the live proposal. |
| Reused `OptimizationApproval` | Unchanged; records proposal decisions and the hash |
| `OpportunityAnalysis` | `+evidenceSnapshot`, `+staleAt`, `+staleReason` |
| `OptimizationOpportunity` | `+rejectionReason`, `+reviewedById`, `+reviewedAt` |

## Phase 5 changes (compatible)

- Analyses now store `evidenceSnapshot`.
- Analysis is allowed for `DETECTED`, `REVIEWED` and `PROPOSED` opportunities.

## Frontend

`/optimization/opportunities/[id]` keeps all Phase 4 cards and adds:
- a back link and a "Reject opportunity" action
- current page version (ID, crawl time, title, meta, H1–H6 outline, analyzed-version mismatch flag)
- an AI analysis panel with a state banner and Analyze / Re-analyze buttons, plus summary, observations, interpretations (labeled as not established facts, with confidence), search intent, content gaps, areas to investigate and caveats
- a recommendation card for each recommendation: AI original and human edit, rationale, evidence, current value, and Edit / Approve / Reject
- proposals with current vs proposed values, version, source, mismatch warning, and Approve / Reject / new revision
- the disclaimer: "AI recommendations are suggestions… do not guarantee ranking, traffic, or CTR improvements"

Polling runs only while an AI run is queued or running. Write actions are hidden for viewers.

## Tests

- `test/review.test.ts` (24): state machine, approve → proposal → approval, edit preserving the original, rejection, duplicate and concurrent approvals (recommendation and proposal), validation, revisions, proposal rejection, transaction rollback, Phase 5 analysis unchanged, staleness (page version and evidence), proposal version mismatch for Phase 7, re-analysis history, opportunity rejection, Phase 4 interplay, open-list filter, 404/403/401.
- `test/review-unit.test.ts` (9): staleness rules and boundaries, change-type mapping, value validation, hash.
