"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { ReviewActions } from "@/hooks/use-review";
import { fmtDateTime, fmtInt, fmtPct, fmtPos } from "@/lib/format";
import type { Analysis, AnalysisState, ApplyRun, ChangeType, Proposal, RecommendationReview, RejectionReason, ReviewPayload } from "@/lib/types";
import { OriginalityGate, OriginalitySection } from "./originality";
import { Banner, Button, Card, Chip, ErrorText, selectClass, type Tone } from "./ui";

export const AI_DISCLAIMER =
  "AI recommendations are suggestions based on the available Search Console and crawled-page evidence. They do not guarantee ranking, traffic, or CTR improvements, and nothing is changed on your website without an approved proposal.";

const REC_LABEL: Record<string, string> = {
  TITLE: "Page title",
  META_DESCRIPTION: "Meta description",
  HEADING: "Heading",
  SECTION_EXPANSION: "Section expansion",
  MISSING_TOPIC: "Missing topic",
  CLARIFICATION: "Clarification",
  INTERNAL_LINK: "Internal link",
  INTRODUCTION: "Introduction",
};

const CHANGE_LABEL: Record<ChangeType, string> = {
  TITLE: "Title",
  META_DESCRIPTION: "Meta description",
  H1: "H1",
  SECTION_HEADING: "Section heading",
  SECTION_CONTENT: "Section text",
};
const SECTION_CHANGES: ChangeType[] = ["SECTION_HEADING", "SECTION_CONTENT"];

const REJECT_LABEL: Record<RejectionReason, string> = {
  NOT_RELEVANT: "Not relevant",
  INCORRECT: "Incorrect",
  ALREADY_ADDRESSED: "Already addressed",
  NOT_WORTH_CHANGING: "Not worth changing",
  OTHER: "Other",
};

const REVIEW_TONE: Record<RecommendationReview["status"], Tone> = { PENDING: "coral", EDITED: "coral", APPROVED: "teal", REJECTED: "rest" };
const PROPOSAL_TONE: Record<Proposal["status"], Tone> = { AWAITING_APPROVAL: "coral", APPROVED: "teal", REJECTED: "rest", APPLIED: "teal", SUPERSEDED: "rest", FAILED: "coral" };
const pct = (n: number) => `${Math.round(n * 100)}%`;
const textareaClass =
  "w-full rounded-[5px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-teal focus:ring-1 focus:ring-teal";

// ───────────────────────── Analysis ─────────────────────────

function StateBanner({ review, canEdit, actions }: { review: ReviewPayload; canEdit: boolean; actions: ReviewActions }) {
  const s: AnalysisState = review.analysisState;
  const busy = actions.analyze.isPending || actions.reanalyze.isPending;
  const analyzeBtn = (label: string, re: boolean) =>
    canEdit && (
      <Button variant={re ? "secondary" : "primary"} disabled={busy} onClick={() => (re ? actions.reanalyze : actions.analyze).mutate(undefined)}>
        {label}
      </Button>
    );
  const message: Record<AnalysisState, [Tone, ReactNode]> = {
    NO_ANALYSIS: ["rest", "AI analysis has not been run yet."],
    QUEUED: ["teal", "Analyzing this opportunity… (queued)"],
    RUNNING: ["teal", "Analyzing this opportunity…"],
    COMPLETED: ["rest", <>AI analysis completed {fmtDateTime(review.analysis?.createdAt ?? null)} · page version v{review.analysis?.pageVersionNo ?? "—"}</>],
    FAILED: ["coral", <>AI analysis failed{review.latestRun?.errorCode ? ` (${review.latestRun.errorCode.toLowerCase().replace(/_/g, " ")})` : ""}.</>],
    STALE: [
      "coral",
      review.analysis?.staleReason === "EVIDENCE_CHANGED"
        ? "The Search Console evidence changed significantly since this analysis. Re-analysis is required before approving."
        : "This analysis was generated from an older version of this page. Re-analysis is required before approving.",
    ],
  };
  const [tone, text] = message[s];
  return (
    <div className="space-y-2">
      <Banner tone={tone}>
        <span className="flex-1">{text}</span>
        {s === "NO_ANALYSIS" && analyzeBtn("Analyze", false)}
        {(s === "FAILED" || s === "STALE" || s === "COMPLETED") && analyzeBtn("Re-analyze", s === "COMPLETED")}
      </Banner>
      <ErrorText error={actions.analyze.error ?? actions.reanalyze.error} />
    </div>
  );
}

function List({ items, empty }: { items: ReactNode[]; empty: string }) {
  if (!items.length) return <p className="text-[12.5px] text-ink3">{empty}</p>;
  return <ul className="space-y-2.5 text-[13px]">{items}</ul>;
}

function AnalysisBody({ a }: { a: Analysis }) {
  return (
    <div className="space-y-5">
      <p className="text-[13.4px] leading-relaxed">{a.summary}</p>
      {!a.evidenceSufficient && (
        <Banner tone="coral">
          <span>
            The AI reported that the evidence is insufficient: {a.insufficientEvidenceNotes.join(" ")}
          </span>
        </Banner>
      )}
      <section>
        <h3 className="mb-2 text-[13px]">Observations <span className="font-normal text-ink3">— what the data shows</span></h3>
        <List
          empty="None."
          items={a.observations.map((o, n) => (
            <li key={n}>
              <span className="mr-1.5 font-mono text-[10.5px] text-ink3">{o.type}</span>
              {o.statement}
              <div className="mt-1 flex flex-wrap gap-1">{o.evidence.map((e, i) => <Chip key={i} tone="rest">{e}</Chip>)}</div>
            </li>
          ))}
        />
      </section>
      <section>
        <h3 className="mb-2 text-[13px]">Interpretations <span className="font-normal text-ink3">— possible explanations, not established facts</span></h3>
        <List
          empty="None offered."
          items={a.interpretations.map((i, n) => (
            <li key={n}>
              {i.statement} <span className="font-mono text-[11px] text-ink3">confidence {pct(i.confidence)}</span>
              <div className="mt-0.5 text-[12px] text-ink2">Based on: {i.basedOn.join("; ")}</div>
            </li>
          ))}
        />
      </section>
      <section>
        <h3 className="mb-2 text-[13px]">Search intent</h3>
        {a.searchIntent.length ? (
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] text-ink3"><tr><th className="pb-1 font-medium">Query</th><th className="pb-1 font-medium">Intent</th><th className="pb-1 text-right font-medium">Confidence</th></tr></thead>
            <tbody className="divide-y divide-line2">
              {a.searchIntent.map((s) => (
                <tr key={s.query} title={s.reasoning}>
                  <td className="py-1.5">{s.query}</td>
                  <td className="py-1.5"><Chip tone="rest">{s.intent.toLowerCase()}</Chip></td>
                  <td className="py-1.5 text-right font-mono">{pct(s.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-[12.5px] text-ink3">No queries classified.</p>}
      </section>
      <section>
        <h3 className="mb-2 text-[13px]">Content gaps</h3>
        <List
          empty="No content gaps identified."
          items={a.contentGaps.map((g, n) => (
            <li key={n}>
              <span className="font-medium">{g.topic}</span> <span className="font-mono text-[11px] text-ink3">confidence {pct(g.confidence)}</span>
              <div className="text-ink2">{g.evidence}</div>
              <div className="mt-1 flex flex-wrap gap-1">{g.relatedQueries.map((q) => <Chip key={q} tone="rest">{q}</Chip>)}</div>
            </li>
          ))}
        />
      </section>
      {a.areasForInvestigation.length > 0 && (
        <section>
          <h3 className="mb-2 text-[13px]">Worth investigating</h3>
          <ul className="ml-5 list-disc space-y-1 text-[13px]">{a.areasForInvestigation.map((x, n) => <li key={n}>{x}</li>)}</ul>
        </section>
      )}
      {a.caveats.length > 0 && <p className="text-[12px] text-ink3">Caveats: {a.caveats.join(" ")}</p>}
      <p className="text-[11.5px] text-ink3">Model {a.model}</p>
    </div>
  );
}

export function AnalysisPanel({ review, canEdit, actions }: { review: ReviewPayload; canEdit: boolean; actions: ReviewActions }) {
  return (
    <Card title="AI analysis">
      <div className="space-y-4">
        <StateBanner review={review} canEdit={canEdit} actions={actions} />
        {review.analysis && <AnalysisBody a={review.analysis} />}
      </div>
    </Card>
  );
}

// ───────────────────────── Recommendations ─────────────────────────

type Mode = null | "edit" | "approve" | "reject" | "revise";

export function RecommendationCard({
  rec,
  review,
  canEdit,
  actions,
}: {
  rec: RecommendationReview;
  review: ReviewPayload;
  canEdit: boolean;
  actions: ReviewActions;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const e = rec.effective;
  const decidable = rec.status === "PENDING" || rec.status === "EDITED";
  const analysisCurrent = review.analysisState === "COMPLETED";
  const reviewable = canEdit && ["DETECTED", "REVIEWED", "PROPOSED"].includes(review.opportunity.status);
  const liveProposal = rec.proposals.find((p) => p.status === "AWAITING_APPROVAL" || p.status === "APPROVED");

  return (
    <section className="rounded-lg border border-line bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-line2 px-[15px] py-[11px]">
        <h3 className="flex-1">{REC_LABEL[e.type] ?? e.type}</h3>
        <Chip tone="rest">{e.priority.toLowerCase()} priority</Chip>
        <Chip tone={REVIEW_TONE[rec.status]}>{rec.status.toLowerCase()}</Chip>
      </header>
      <div className="space-y-3 p-[15px] text-[13px]">
        <div>
          <p className="mb-0.5 text-[11.5px] text-ink3">AI recommendation (suggestion)</p>
          <p className={rec.edited ? "text-ink2 line-through decoration-ink3" : ""}>{rec.original.recommendation}</p>
        </div>
        {rec.edited && (
          <div>
            <p className="mb-0.5 text-[11.5px] text-ink3">Edited by a reviewer {fmtDateTime(rec.editedAt)}</p>
            <p>{rec.edited.recommendation}</p>
          </div>
        )}
        <p className="text-ink2"><span className="text-ink3">Rationale:</span> {e.rationale}</p>
        <div className="flex flex-wrap gap-1">{e.evidence.map((x, n) => <Chip key={n} tone="rest">{x}</Chip>)}</div>
        {e.targetSection && <p className="text-[12px] text-ink3">Section: <span className="font-mono">{e.targetSection}</span></p>}
        {rec.suggestedChangeType && rec.currentValue != null && !(rec.draftTarget === "SECTION_BODY" && rec.bodyComparison) && (
          <div>
            <p className="mb-0.5 text-[11.5px] text-ink3">Current {CHANGE_LABEL[rec.suggestedChangeType].toLowerCase()} (analyzed version)</p>
            <p className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-line2 bg-rail px-2 py-1.5">{rec.currentValue}</p>
          </div>
        )}
        <DraftBlock rec={rec} canRegenerate={reviewable && analysisCurrent && rec.status !== "REJECTED"} actions={actions} />
        {rec.status === "REJECTED" && (
          <p className="text-[12.5px] text-ink2">
            Rejected: {rec.rejectionReason ? REJECT_LABEL[rec.rejectionReason] : "—"}
            {rec.rejectionNote && ` — ${rec.rejectionNote}`}
          </p>
        )}

        {reviewable && decidable && mode === null && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="secondary" onClick={() => setMode("edit")}>Edit</Button>
            <Button onClick={() => setMode("approve")} disabled={!analysisCurrent} title={analysisCurrent ? undefined : "Re-analysis required"}>Approve</Button>
            <Button variant="danger" onClick={() => setMode("reject")}>Reject</Button>
          </div>
        )}
        {mode === "edit" && <EditForm rec={rec} actions={actions} onDone={() => setMode(null)} />}
        {(mode === "approve" || mode === "revise") && (
          <ProposalForm rec={rec} review={review} actions={actions} revise={mode === "revise"} onDone={() => setMode(null)} />
        )}
        {mode === "reject" && <RejectForm rec={rec} actions={actions} onDone={() => setMode(null)} />}

        {rec.proposals.length > 0 && (
          <div className="space-y-2 border-t border-line2 pt-3">
            <h4 className="text-[12.5px] font-medium">Proposal</h4>
            {[...rec.proposals].reverse().map((p) => (
              <ProposalView key={p.id} p={p} canDecide={reviewable && analysisCurrent} canApply={canEdit} actions={actions} />
            ))}
            {reviewable && analysisCurrent && rec.status === "APPROVED" && mode === null && (
              <Button variant="secondary" onClick={() => setMode("revise")}>{liveProposal ? "Propose a different change" : "Create new proposal"}</Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const SOURCE_LABEL: Record<Proposal["source"], string> = {
  AI_DRAFT: "unedited AI draft",
  HUMAN_EDITED: "human-edited",
  AI_RECOMMENDATION: "from AI recommendation",
};

const pctSigned = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n * 100)}%`;
const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;

/** Body-section rewrite: which section changes, original vs proposed, size of the change and validation status. */
function BodyComparison({ rec }: { rec: RecommendationReview }) {
  const c = rec.bodyComparison!;
  const d = rec.draft;
  const m = c.metrics;
  return (
    <div className="space-y-2">
      <p className="rounded border border-coral-br bg-coral-bg px-2 py-1.5 text-[12px]">
        Rewrites the body text of the section <span className="font-medium">“{c.heading ?? "Introduction"}”</span> <span className="font-mono text-ink3">({c.sectionKey})</span> only. Its heading and every other section stay as they are.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <p className="mb-0.5 text-[11px] text-ink3">Original (analyzed version) · {wordCount(c.original)} words</p>
          <p className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-rail px-2 py-1.5 text-[12.5px]">{c.original}</p>
        </div>
        <div>
          <p className="mb-0.5 text-[11px] text-ink3">
            {d ? <>Proposed · AI draft {d.revision} · {m?.draftWords ?? wordCount(d.value)} words</> : "Proposed"}
          </p>
          {d ? (
            <p className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-teal-bg px-2 py-1.5 text-[12.5px]">{d.value}</p>
          ) : (
            <p className="rounded border border-dashed border-line px-2 py-3 text-[12.5px] text-ink3">No rewrite yet. Request one below. A rewrite must keep every number, name and caveat, and add nothing new; drafts that don’t are discarded.</p>
          )}
        </div>
      </div>
      {d && m && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <Chip tone={d.validation?.passed ? "teal" : "rest"}>{d.validation?.passed ? "passed fact-preservation checks" : "not validated"}</Chip>
          <Chip tone="rest">length {pctSigned(m.lengthChange)}</Chip>
          <Chip tone="rest">{Math.round(m.changeRatio * 100)}% of words changed</Chip>
          <Chip tone="rest">{Math.round(m.factPreservation * 100)}% of numbers and names kept</Chip>
          <Chip tone="rest">{Math.round(m.termOverlap * 100)}% of key terms kept</Chip>
        </div>
      )}
      {d && <p className="text-[11.5px] text-ink3">Checks are automatic and conservative. Read the rewrite against the original before approving; you remain responsible for its accuracy.</p>}
    </div>
  );
}

function DraftBlock({ rec, canRegenerate, actions }: { rec: RecommendationReview; canRegenerate: boolean; actions: ReviewActions }) {
  if (!rec.draftable) return null;
  if (rec.draftTarget === "SECTION_BODY" && rec.bodyComparison) return <BodyDraftBlock rec={rec} canRegenerate={canRegenerate} actions={actions} />;
  const busy = actions.regenerateDraft.isPending && actions.regenerateDraft.variables?.recId === rec.id;
  const error = actions.regenerateDraft.variables?.recId === rec.id ? actions.regenerateDraft.error : null;
  return (
    <div>
      <p className="mb-0.5 text-[11.5px] text-ink3">
        AI draft{rec.draft ? (rec.draft.revision ? ` (new draft ${rec.draft.revision})` : " (from the analysis)") : ""} — a starting point to review and edit
      </p>
      {rec.draft ? (
        <p className="whitespace-pre-wrap rounded border border-line2 bg-teal-bg px-2 py-1.5">{rec.draft.value}</p>
      ) : (
        <p className="text-[12.5px] text-ink3">
          {rec.draftIssues.length
            ? `The AI's draft was discarded because it failed validation (${rec.draftIssues[0]}). Write the copy yourself or request a new draft.`
            : "No AI draft is available. Write the copy yourself or request a new draft."}
        </p>
      )}
      {rec.draft?.note && <p className="mt-0.5 text-[12px] text-ink3">{rec.draft.note}</p>}
      {rec.draft && (
        <div className="mt-2">
          <OriginalitySection rec={rec} actions={actions} text={rec.draft.value} changeType={rec.suggestedChangeType} targetSection={rec.effective.targetSection} draftId={rec.draft.id} canCheck={canRegenerate} />
        </div>
      )}
      {canRegenerate && (
        <div className="mt-1.5 flex items-center gap-2">
          <Button variant="secondary" disabled={busy || rec.draftRegenerationsLeft === 0} onClick={() => actions.regenerateDraft.mutate({ recId: rec.id })}>
            {busy ? "Drafting…" : "Request new draft"}
          </Button>
          <span className="text-[11.5px] text-ink3">{rec.draftRegenerationsLeft} left</span>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function BodyDraftBlock({ rec, canRegenerate, actions }: { rec: RecommendationReview; canRegenerate: boolean; actions: ReviewActions }) {
  const busy = actions.regenerateDraft.isPending && actions.regenerateDraft.variables?.recId === rec.id;
  const error = actions.regenerateDraft.variables?.recId === rec.id ? actions.regenerateDraft.error : null;
  return (
    <div className="space-y-2">
      <p className="text-[11.5px] text-ink3">AI rewrite of the section body: a starting point to review and edit</p>
      <BodyComparison rec={rec} />
      {rec.draft?.note && <p className="text-[12px] text-ink3">{rec.draft.note}</p>}
      {rec.draft && (
        <OriginalitySection rec={rec} actions={actions} text={rec.draft.value} changeType="SECTION_CONTENT" targetSection={rec.bodyComparison!.sectionKey} draftId={rec.draft.id} canCheck={canRegenerate} />
      )}
      {canRegenerate && (
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={busy || rec.draftRegenerationsLeft === 0} onClick={() => actions.regenerateDraft.mutate({ recId: rec.id })}>
            {busy ? "Rewriting…" : rec.draft ? "Request new draft" : "Draft a rewrite"}
          </Button>
          <span className="text-[11.5px] text-ink3">{rec.draftRegenerationsLeft} left</span>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function EditForm({ rec, actions, onDone }: { rec: RecommendationReview; actions: ReviewActions; onDone: () => void }) {
  const [recommendation, setRecommendation] = useState(rec.effective.recommendation);
  const [rationale, setRationale] = useState(rec.effective.rationale);
  function submit(ev: FormEvent) {
    ev.preventDefault();
    actions.edit.mutate({ recId: rec.id, recommendation, rationale }, { onSuccess: onDone });
  }
  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-line2 bg-rail p-3">
      <label className="block text-[12px] text-ink2">Recommendation
        <textarea className={textareaClass} rows={3} value={recommendation} maxLength={800} onChange={(x) => setRecommendation(x.target.value)} required />
      </label>
      <label className="block text-[12px] text-ink2">Rationale
        <textarea className={textareaClass} rows={2} value={rationale} maxLength={800} onChange={(x) => setRationale(x.target.value)} required />
      </label>
      <p className="text-[11.5px] text-ink3">The AI original is kept; your edit is stored alongside it.</p>
      <ErrorText error={actions.edit.error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={actions.edit.isPending}>Save edit</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function ProposalForm({ rec, review, actions, revise, onDone }: { rec: RecommendationReview; review: ReviewPayload; actions: ReviewActions; revise: boolean; onDone: () => void }) {
  const sections = review.page.currentVersion?.pageSections ?? [];
  const [changeType, setChangeType] = useState<ChangeType>(rec.suggestedChangeType ?? "SECTION_CONTENT");
  const [targetSection, setTargetSection] = useState<string>(rec.effective.targetSection ?? sections[0]?.sectionKey ?? "");
  // Until the reviewer types, the value follows the latest AI draft (so a newly requested draft shows up here).
  const [typed, setTyped] = useState<string | null>(null);
  const proposedValue = typed ?? rec.draft?.value ?? rec.currentValue ?? "";
  const isSection = SECTION_CHANGES.includes(changeType);
  const unchanged =
    changeType === rec.suggestedChangeType && rec.currentValue != null && proposedValue.replace(/\s+/g, " ").trim() === rec.currentValue.replace(/\s+/g, " ").trim();
  const m = revise ? actions.newProposal : actions.approve;
  const send = (acknowledgeOriginalityCheckId?: string) =>
    m.mutate({ recId: rec.id, changeType, targetSection: isSection ? targetSection : null, proposedValue, acknowledgeOriginalityCheckId }, { onSuccess: onDone });
  function submit(ev: FormEvent) {
    ev.preventDefault();
    send();
  }
  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-line2 bg-rail p-3">
      <p className="text-[12px] text-ink2">
        {revise ? "Create a new proposal revision. The previous one is kept and marked superseded." : "Approving creates a concrete proposal that still needs your approval below. Nothing changes on the website."}
      </p>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Change type" className={selectClass} value={changeType} onChange={(x) => setChangeType(x.target.value as ChangeType)}>
          {(Object.keys(CHANGE_LABEL) as ChangeType[]).map((c) => <option key={c} value={c}>{CHANGE_LABEL[c]}</option>)}
        </select>
        {isSection && (
          <select aria-label="Section" className={selectClass} value={targetSection} onChange={(x) => setTargetSection(x.target.value)}>
            {sections.map((s) => <option key={s.sectionKey} value={s.sectionKey}>{s.heading ?? "Introduction"} ({s.sectionKey})</option>)}
          </select>
        )}
      </div>
      <label className="block text-[12px] text-ink2">Proposed value
        <textarea
          className={textareaClass}
          rows={changeType === "SECTION_CONTENT" ? 8 : 2}
          value={proposedValue}
          onChange={(x) => setTyped(x.target.value)}
          required
        />
      </label>
      {rec.draft && proposedValue === rec.draft.value && <p className="text-[11.5px] text-ink3">Pre-filled with the AI draft. Edit it as needed; the proposal records whether it was changed.</p>}
      {unchanged && <p className="text-[11.5px] text-coral">This is the current value. Change it before creating a proposal.</p>}
      {changeType === "SECTION_CONTENT" && rec.currentValue && (
        <p className="text-[11.5px] text-ink3">
          {wordCount(proposedValue)} words vs {wordCount(rec.currentValue)} in the original ({pctSigned((wordCount(proposedValue) - wordCount(rec.currentValue)) / Math.max(1, wordCount(rec.currentValue)))})
        </p>
      )}
      <OriginalitySection rec={rec} actions={actions} text={proposedValue} changeType={changeType} targetSection={isSection ? targetSection : null} canCheck />
      <OriginalityGate key={m.submittedAt} error={m.error} pending={m.isPending} onAcknowledge={(id) => send(id)} />
      <div className="flex gap-2">
        <Button type="submit" disabled={m.isPending || unchanged}>{revise ? "Create proposal" : "Approve & create proposal"}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function RejectForm({ rec, actions, onDone }: { rec: RecommendationReview; actions: ReviewActions; onDone: () => void }) {
  const [reason, setReason] = useState<RejectionReason>("NOT_RELEVANT");
  const [note, setNote] = useState("");
  function submit(ev: FormEvent) {
    ev.preventDefault();
    actions.reject.mutate({ recId: rec.id, reason, note: note.trim() || undefined }, { onSuccess: onDone });
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-md border border-line2 bg-rail p-3">
      <select aria-label="Reason" className={selectClass} value={reason} onChange={(x) => setReason(x.target.value as RejectionReason)}>
        {(Object.keys(REJECT_LABEL) as RejectionReason[]).map((r) => <option key={r} value={r}>{REJECT_LABEL[r]}</option>)}
      </select>
      <input className={`min-w-[200px] flex-1 ${textareaClass}`} placeholder="Note (optional)" value={note} maxLength={500} onChange={(x) => setNote(x.target.value)} />
      <Button type="submit" variant="danger" disabled={actions.reject.isPending}>Reject</Button>
      <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      <div className="w-full"><ErrorText error={actions.reject.error} /></div>
    </form>
  );
}

function ProposalView({ p, canDecide, canApply, actions }: { p: Proposal; canDecide: boolean; canApply: boolean; actions: ReviewActions }) {
  const live = p.status === "AWAITING_APPROVAL" || p.status === "APPROVED";
  return (
    <div className={`rounded-md border px-3 py-2.5 ${live ? "border-line" : "border-line2 opacity-70"}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium">{CHANGE_LABEL[p.changeType]}</span>
        {p.targetSection && <span className="font-mono text-ink3">{p.targetSection}</span>}
        <Chip tone={PROPOSAL_TONE[p.status]}>{p.status.toLowerCase().replace(/_/g, " ")}</Chip>
        <span className="text-ink3">rev {p.revision} · page version v{p.pageVersionNo} · {SOURCE_LABEL[p.source]}</span>
        {p.originalityStatus && p.originalityStatus !== "NOT_CHECKED" && (
          <Chip tone={p.originalityStatus === "CHECKED" ? "rest" : "coral"}>
            originality {p.originalityStatus === "CHECKED" ? "checked" : "check failed"}{p.originalityAcknowledgedAt ? " · matches acknowledged" : ""}
          </Chip>
        )}
      </div>
      {live && !p.matchesCurrentPageVersion && !p.apply?.run && (
        <p className="mb-2 text-[12px] text-coral">The page has changed since version v{p.pageVersionNo}. This proposal cannot be applied as-is.</p>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <p className="mb-0.5 text-[11px] text-ink3">Current</p>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-rail px-2 py-1.5 text-[12.5px]">{p.currentValue ?? <span className="text-ink3">(empty)</span>}</p>
        </div>
        <div>
          <p className="mb-0.5 text-[11px] text-ink3">Proposed</p>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-teal-bg px-2 py-1.5 text-[12.5px]">{p.proposedValue}</p>
        </div>
      </div>
      {p.status === "REJECTED" && p.rejectionReason && <p className="mt-1.5 text-[12px] text-ink2">Rejected: {p.rejectionReason}</p>}
      {p.status === "APPROVED" && !p.apply?.run && <p className="mt-1.5 text-[12px] text-ink2">Approved {fmtDateTime(p.approvedAt)}. Not applied yet.</p>}
      {(p.status === "APPROVED" || p.apply?.run) && <ApplyPanel p={p} canApply={canApply} actions={actions} />}
      {canDecide && p.status === "AWAITING_APPROVAL" && (
        <div className="mt-2 flex gap-2">
          <Button disabled={actions.approveProposal.isPending || !p.matchesCurrentPageVersion} onClick={() => actions.approveProposal.mutate({ proposalId: p.id })}>Approve proposal</Button>
          <Button
            variant="danger"
            disabled={actions.rejectProposal.isPending}
            onClick={() => {
              const reason = window.prompt("Reject this proposal? Optionally add a reason.");
              if (reason !== null) actions.rejectProposal.mutate({ proposalId: p.id, reason: reason.trim() || undefined });
            }}
          >
            Reject proposal
          </Button>
        </div>
      )}
      {actions.approveProposal.variables?.proposalId === p.id && (
        <OriginalityGate
          key={actions.approveProposal.submittedAt}
          error={actions.approveProposal.error}
          pending={actions.approveProposal.isPending}
          onAcknowledge={(id) => actions.approveProposal.mutate({ proposalId: p.id, acknowledgeOriginalityCheckId: id })}
        />
      )}
      <ErrorText error={actions.rejectProposal.error} />
    </div>
  );
}

// ───────────────────────── Apply & verify (Phase 7a) ─────────────────────────

const FAILURE_TEXT: Record<string, string> = {
  CONTENT_CONFLICT: "The live page shows a different value from both the approved one and the one it replaced. Nothing was changed. Set the exact approved value and check again, or abandon this opportunity and re-analyze the page.",
  TARGET_MISSING: "The part of the page this change edits couldn’t be found (the page structure changed). Check the page, or abandon and re-analyze.",
  PAGE_GONE: "The page returned “not found”. Check the URL is published, then check again.",
  PAGE_REDIRECTED: "The page now redirects elsewhere, so the change couldn’t be verified on this URL.",
  ROBOTS_DISALLOWED: "robots.txt blocks our crawler from this page, so it couldn’t be checked.",
  NOT_HTML: "The URL didn’t return an HTML page.",
  FETCH_FAILED: "The page couldn’t be fetched (network error, timeout or server error). Nothing was concluded; check again later.",
  INTERNAL: "The check stopped unexpectedly. Nothing was concluded; check again.",
  PROPOSAL_INTEGRITY: "This proposal no longer matches its approval record, so it can’t be verified.",
  ABANDONED: "Verification was stopped because the opportunity was abandoned.",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => setCopied(false),
        )
      }
    >
      {copied ? "Copied" : "Copy approved value"}
    </Button>
  );
}

function RunStatus({ run }: { run: ApplyRun }) {
  const d = run.verificationDetail;
  if (run.status === "APPLYING") return <Banner tone="teal">Checking the live page… (attempt {run.verificationAttempts})</Banner>;
  if (run.status === "APPLIED")
    return (
      <Banner tone="teal">
        Verified on the live page {fmtDateTime(run.verifiedAt)}{d?.liveVersionNo ? ` (page version v${d.liveVersionNo})` : ""}. You made this change on your site; RankFix AI only checked it.
      </Banner>
    );
  if (run.status === "AWAITING_CHANGE")
    return (
      <Banner tone="coral">
        The live page still shows the previous value (checked {fmtDateTime(run.lastCheckedAt)}). Publish the change, clear any page cache, then check again.
      </Banner>
    );
  return (
    <Banner tone="coral">
      Not verified{run.verificationError ? ` (${run.verificationError.toLowerCase().replace(/_/g, " ")})` : ""}: {FAILURE_TEXT[run.verificationError ?? ""] ?? "The check failed."}
      {d?.httpStatus ? ` HTTP ${d.httpStatus}.` : ""}
    </Banner>
  );
}

function BaselineView({ run }: { run: ApplyRun }) {
  const b = run.baseline;
  if (!b) return <p className="text-[11.5px] text-ink3">No pre-change Search Console baseline was stored (no synced data for this page’s property).</p>;
  return (
    <div className="text-[12px]">
      <p className="mb-1 text-[11.5px] text-ink3">
        Pre-change baseline · Search Console {b.windowStart.slice(0, 10)} – {b.windowEnd.slice(0, 10)}
        {!b.dataComplete && " · incomplete: stored data doesn’t cover the whole window"}
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span>Clicks <b>{fmtInt(b.clicks)}</b></span>
        <span>Impressions <b>{fmtInt(b.impressions)}</b></span>
        <span>CTR <b>{b.impressions > 0 ? fmtPct(b.ctr) : "—"}</b></span>
        <span>Avg. position <b>{fmtPos(b.position)}</b></span>
      </div>
      <p className="mt-1 text-[11px] text-ink3">Before/after comparison comes later; changes in these numbers can’t be attributed to this edit alone.</p>
    </div>
  );
}

function ApplyPanel({ p, canApply, actions }: { p: Proposal; canApply: boolean; actions: ReviewActions }) {
  const run = p.apply?.run ?? null;
  const pending = actions.markApplied.isPending && actions.markApplied.variables?.proposalId === p.id;
  return (
    <div className="mt-2.5 space-y-2 border-t border-line2 pt-2.5">
      <p className="text-[12px] font-medium">Apply this change</p>
      {!run && (
        <p className="text-[12px] text-ink2">
          RankFix AI doesn’t edit your website. Set the {CHANGE_LABEL[p.changeType].toLowerCase()} on your site to the approved value exactly, publish it, then confirm below. We’ll recrawl this one page and compare.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {p.status !== "APPLIED" && <CopyButton text={p.proposedValue} />}
        {canApply && p.apply?.canMarkApplied && (
          <Button disabled={pending} onClick={() => actions.markApplied.mutate({ proposalId: p.id })}>I’ve applied this</Button>
        )}
        {canApply && p.apply?.canRetry && (
          <Button variant="secondary" disabled={pending} onClick={() => actions.markApplied.mutate({ proposalId: p.id })}>Check again</Button>
        )}
      </div>
      {run && <RunStatus run={run} />}
      {run && <BaselineView run={run} />}
      {actions.markApplied.variables?.proposalId === p.id && <ErrorText error={actions.markApplied.error} />}
    </div>
  );
}
