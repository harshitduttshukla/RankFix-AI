"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { ReviewActions } from "@/hooks/use-review";
import { fmtDateTime } from "@/lib/format";
import type { Analysis, AnalysisState, ChangeType, Proposal, RecommendationReview, RejectionReason, ReviewPayload } from "@/lib/types";
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
        {rec.suggestedChangeType && rec.currentValue != null && (
          <div>
            <p className="mb-0.5 text-[11.5px] text-ink3">Current {CHANGE_LABEL[rec.suggestedChangeType].toLowerCase()} (analyzed version)</p>
            <p className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-line2 bg-rail px-2 py-1.5">{rec.currentValue}</p>
          </div>
        )}
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
              <ProposalView key={p.id} p={p} canDecide={reviewable && analysisCurrent} actions={actions} />
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
  const [proposedValue, setProposedValue] = useState(rec.currentValue ?? "");
  const isSection = SECTION_CHANGES.includes(changeType);
  const m = revise ? actions.newProposal : actions.approve;
  function submit(ev: FormEvent) {
    ev.preventDefault();
    m.mutate({ recId: rec.id, changeType, targetSection: isSection ? targetSection : null, proposedValue }, { onSuccess: onDone });
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
        <textarea className={textareaClass} rows={changeType === "SECTION_CONTENT" ? 8 : 2} value={proposedValue} onChange={(x) => setProposedValue(x.target.value)} required />
      </label>
      <ErrorText error={m.error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={m.isPending}>{revise ? "Create proposal" : "Approve & create proposal"}</Button>
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

function ProposalView({ p, canDecide, actions }: { p: Proposal; canDecide: boolean; actions: ReviewActions }) {
  const live = p.status === "AWAITING_APPROVAL" || p.status === "APPROVED";
  return (
    <div className={`rounded-md border px-3 py-2.5 ${live ? "border-line" : "border-line2 opacity-70"}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium">{CHANGE_LABEL[p.changeType]}</span>
        {p.targetSection && <span className="font-mono text-ink3">{p.targetSection}</span>}
        <Chip tone={PROPOSAL_TONE[p.status]}>{p.status.toLowerCase().replace(/_/g, " ")}</Chip>
        <span className="text-ink3">rev {p.revision} · page version v{p.pageVersionNo} · {p.source === "HUMAN_EDITED" ? "human-edited" : "from AI recommendation"}</span>
      </div>
      {live && !p.matchesCurrentPageVersion && (
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
      {p.status === "APPROVED" && <p className="mt-1.5 text-[12px] text-ink2">Approved {fmtDateTime(p.approvedAt)}. Ready for the content-update step; not yet applied.</p>}
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
      <ErrorText error={actions.approveProposal.error ?? actions.rejectProposal.error} />
    </div>
  );
}
