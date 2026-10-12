# Content originality check

Checks proposed text for verbatim or near-verbatim overlap with other pages before it can be approved. It covers titles, meta descriptions, H1s, section headings and intro text, whether the text is an AI draft or a reviewer's edit. It is separate from the factual-grounding and overclaim checks in `services/ai/drafts.ts` and `ai.guardrails.ts`, which still run unchanged.

**What it is not:** a web plagiarism search, a paraphrase detector, an AI-writing detector, or proof that text is original. Every result lists these limitations. The overlap figure is the share of the text's words inside flagged passages. It is not a plagiarism score.

## Corpus: internal only

The checker compares against the **current version of every crawled page in the same organization and project**: titles, meta descriptions, H1s, section headings and section text.
- The field being replaced on the target page is excluded.
- Other text on the same page is reported as `INFO`, because drafts are required to reuse the page's own facts. It never counts toward the assessment.
- Other projects, other organizations and the public web are never searched.
- No text is sent outside the server, and no external service or paid API is used.

## Architecture

```
services/originality/
  originality.types.ts        OriginalityChecker interface, result types
  fingerprint.ts              normalize → word n-grams → runs → near-verbatim joins → common-phrase filter → dedup → severity
  internal-corpus.checker.ts  InternalCorpusChecker (default) + tenant-scoped corpus loader
  originality.config.ts       env → policy and thresholds
  originality.service.ts      run / reuse / enforce (approval gate), persistence and audit
```

Another implementation, for example a self-hosted engine, can be added behind `OriginalityChecker` and selected in `originality.service.ts`.

### Matching

1. **Normalize.** NFKC, case-folded words. Punctuation, spacing and formatting are ignored, and character offsets are kept so passages can be shown exactly.
2. **Fingerprint and scan.** The checked text is fingerprinted with word n-grams (n = `ORIGINALITY_MIN_MATCH_WORDS`, default 6), and every corpus field is scanned for them.
3. **Drop common phrases.** An n-gram found on at least `max(COMMON_PHRASE_MIN_PAGES, COMMON_PHRASE_RATIO × pages)` distinct pages is boilerplate or terminology, and is ignored.
4. **Build matches.**
   - `EXACT`: consecutive hits form a verbatim run.
   - `NEAR_VERBATIM`: runs separated by up to 3 edited words on both sides are joined.
   - `DUPLICATE_FIELD`: a whole text of at least 3 words equal to a whole field. This catches duplicate titles and headings shorter than n.
5. **Deduplicate.** A match overlapping a stronger one by more than half is folded into it (`alsoFoundIn`).
6. **Grade severity.**
   - `INFO`: same page.
   - `MINOR`: quoted or attributed ("…", "according to …"), or a short overlap.
   - `SIGNIFICANT`: a duplicate field, a verbatim run of at least `SIGNIFICANT_RUN_WORDS` (12), or coverage of at least `SIGNIFICANT_COVERAGE` (0.5) of the text.

   Every match carries an explanation that notes it may be legitimate: a business name, a common phrase, a quotation or attributed material.

The assessment is `NO_MATCHES`, `INFORMATIONAL_MATCHES`, `MINOR_MATCHES` or `SIGNIFICANT_MATCHES`. The result status is `NOT_CHECKED`, `CHECKED` or `CHECK_FAILED`.

## Approval gate and policy

The gate always runs on the **final text** being approved, at both proposal creation and final proposal approval.
- A stored `CHECKED` result is reused only for the identical text, field, page version and checker version, and only within `ORIGINALITY_RESULT_TTL_MINUTES`.
- Any other case runs a new check. Results for different text are stale and never apply.

| `ORIGINALITY_POLICY` | Significant matches |
|---|---|
| `off` | not checked (`NOT_CHECKED` recorded) |
| `warn` | shown, approval allowed |
| `require_ack` (default) | 409 `ORIGINALITY_ACK_REQUIRED` with the result. Resubmit with `acknowledgeOriginalityCheckId` = that check's id (a stale check id doesn't count). |
| `block` | 409 `ORIGINALITY_BLOCKED`; edit the text |

- **Failed checks:** a failed check is stored as `CHECK_FAILED`. With `ORIGINALITY_REQUIRE_CHECK=true` (default), approval returns 503 `ORIGINALITY_CHECK_FAILED`. It is never treated as "no matches".
- **Minor and informational matches** never block.
- **Proposals record the decision:** `originalityCheckId`, `originalityStatus` and the acknowledgment (who and when).

## API

- `POST …/recommendations/:recommendationId/originality` (EDITOR). Body: `{text, changeType?, targetSection?, draftId?}`. Always runs a new check (201). Returns 400 for empty text or a field that isn't checkable.
- The review payload has `originality: {applies, policy, requireCheck, checks[5]}` per recommendation.
- `approve`, `proposal` and `proposals/:id/approve` accept `acknowledgeOriginalityCheckId`.

## Storage and audit

- **`OriginalityCheck` rows** are append-only (migration `…_originality_checks`). Each stores the exact checked text and its sha256, the analyzed page version, the draft id if it was a regenerated draft, the matches, the checker and its version, the limitations and any error.
- **Audit events:** `originality.checked`, `originality.check_failed` and `originality.acknowledged`. `proposal.created` and `proposal.approved` include an `originality` summary.
- **Audit metadata** holds the text hash and length, never the text. Checker errors are logged without the text and stored as our own wording.

## Noplag Engine (evaluated, not integrated)

[NoplagLabs/noplag-engine](https://github.com/NoplagLabs/noplag-engine):
- **What it is:** Apache-2.0, Python 3.12 and Postgres 16, run with Docker Compose. Its HTTP API is asynchronous: `POST /v1/checks` with `{query_text}`, then poll, then fetch `/report`.
- **Corpus:** it matches only a locally indexed corpus. The open-source engine does not search the web; the hosted noplag.com product does.

Why it isn't integrated:
- **No tenant isolation:** it is single-tenant with no authentication, so every organization's pages would share one corpus. That conflicts with our isolation requirement unless we run one instance or corpus per tenant.
- **Built for long text:** it targets documents of at least a few sentences, while titles, meta descriptions and headings are short.
- **Extra infrastructure:** it would need its own service and database, plus a sync of our crawled pages into its corpus.
- **Early-stage:** a young repository with no tagged releases.

Its behavior was not verified against a running instance. If needed later, it can be added as an `OriginalityChecker` behind the existing interface, run per tenant, and enabled explicitly.
