"use client";

import { useState } from "react";
import type { ReviewActions } from "@/hooks/use-review";
import { ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import type { ChangeType, OriginalityAssessment, OriginalityCheck, OriginalityMatch, RecommendationReview } from "@/lib/types";
import { Banner, Button, Chip, ErrorText, type Tone } from "./ui";

/** Same word normalization as the server: case, punctuation and spacing don't make text "different". */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
export const normalizeForMatch = (s: string) => Array.from(s.normalize("NFKC").matchAll(WORD), (m) => m[0].toLowerCase().replace(/’/g, "'")).join(" ");

const ASSESSMENT: Record<OriginalityAssessment, [Tone, string]> = {
  NO_MATCHES: ["teal", "No overlapping passages found in this project’s pages"],
  INFORMATIONAL_MATCHES: ["rest", "Only overlaps with this same page’s own wording"],
  MINOR_MATCHES: ["rest", "Minor overlaps (short or attributed passages)"],
  SIGNIFICANT_MATCHES: ["coral", "Significant overlap with other pages"],
};
const SEVERITY_TONE: Record<OriginalityMatch["severity"], Tone> = { SIGNIFICANT: "coral", MINOR: "rest", INFO: "rest" };
const FIELD: Record<string, string> = { TITLE: "title", META_DESCRIPTION: "meta description", H1: "H1", SECTION_HEADING: "section heading", SECTION_TEXT: "section text" };
const KIND: Record<OriginalityMatch["kind"], string> = { EXACT: "verbatim", NEAR_VERBATIM: "near-verbatim", DUPLICATE_FIELD: "duplicate field" };

/** The originality result carried by an approval error (ack required, blocked, or failed check). */
export function originalityFromError(error: unknown): { code: string; check: OriginalityCheck } | null {
  if (!(error instanceof ApiError) || !error.code.startsWith("ORIGINALITY_")) return null;
  const check = (error.details as { originality?: OriginalityCheck } | undefined)?.originality;
  return check ? { code: error.code, check } : null;
}

export function OriginalityResult({ check }: { check: OriginalityCheck }) {
  if (check.status === "CHECK_FAILED") {
    return (
      <Banner tone="coral">
        The check did not complete{check.error?.message ? `: ${check.error.message}` : "."} Nothing is known about this text’s overlap until it runs successfully.
      </Banner>
    );
  }
  const [tone, label] = ASSESSMENT[check.assessment ?? "NO_MATCHES"];
  const shown = check.matches.filter((m) => m.severity !== "INFO");
  const info = check.matches.length - shown.length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={tone}>{label}</Chip>
        {check.overlapRatio != null && check.overlapRatio > 0 && (
          <span className="text-[11.5px] text-ink3" title="Share of words inside the overlapping passages below. Not a plagiarism score.">
            {Math.round(check.overlapRatio * 100)}% of the words overlap with other pages here
          </span>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((m, i) => (
            <li key={i} className="rounded border border-line2 px-2 py-1.5 text-[12.5px]">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <Chip tone={SEVERITY_TONE[m.severity]}>{m.severity.toLowerCase()}</Chip>
                <span className="text-[11px] text-ink3">{KIND[m.kind]} · {m.words} words{m.attributed ? " · quoted/attributed" : ""}</span>
              </div>
              <p className="rounded bg-coral-bg/40 px-1.5 py-1">“{m.passage}”</p>
              <p className="mt-1 text-ink2">{m.explanation}</p>
              <p className="mt-1 text-[11.5px] text-ink3">
                Source: <a className="text-teal underline" href={m.source.url} target="_blank" rel="noreferrer noopener">{m.source.url}</a> ({FIELD[m.source.field] ?? m.source.field})
                {m.alsoFoundIn.length > 0 && <> · also on {m.alsoFoundIn.map((x, j) => <a key={j} className="ml-1 text-teal underline" href={x.url} target="_blank" rel="noreferrer noopener">{new URL(x.url).pathname}</a>)}</>}
              </p>
            </li>
          ))}
        </ul>
      )}
      {info > 0 && <p className="text-[11.5px] text-ink3">{info} overlap{info === 1 ? "" : "s"} with this page’s own text (expected for drafts that reuse the page’s facts).</p>}
      <details className="text-[11.5px] text-ink3">
        <summary className="cursor-pointer">What this check covers</summary>
        <ul className="ml-4 mt-1 list-disc space-y-0.5">
          {check.limitations.map((l, i) => <li key={i}>{l}</li>)}
          <li>Matching wording can be legitimate: a business or product name, common terminology, a quotation, or properly attributed material.</li>
        </ul>
      </details>
      <p className="text-[11px] text-ink3">
        {check.checker} {check.checkerVersion} · {check.corpusPages ?? 0} pages compared · checked {fmtDateTime(check.checkedAt)}
      </p>
    </div>
  );
}

/**
 * Content Originality for one text (a draft, or the reviewer's edit). Shows the latest result for exactly this
 * text; a result for different text is shown as stale. "Check"/"Run check again" always runs a new check.
 */
export function OriginalitySection({
  rec,
  actions,
  text,
  changeType,
  targetSection,
  draftId,
  canCheck,
}: {
  rec: RecommendationReview;
  actions: ReviewActions;
  text: string;
  changeType: ChangeType | null;
  targetSection: string | null;
  draftId?: string | null;
  canCheck: boolean;
}) {
  const [own, setOwn] = useState<OriginalityCheck | null>(null);
  if (!rec.originality.applies || rec.originality.policy === "off" || !changeType) return null;
  const key = normalizeForMatch(text);
  const all = [...(own ? [own] : []), ...rec.originality.checks];
  const sameField = all.filter((c) => c.changeType === changeType && (c.targetSection ?? null) === (["SECTION_HEADING", "SECTION_CONTENT"].includes(changeType) ? targetSection : null));
  const current = sameField.find((c) => normalizeForMatch(c.text) === key) ?? null;
  const stale = !current && sameField.length > 0;
  const m = actions.checkOriginality;
  const busy = m.isPending && m.variables?.recId === rec.id && m.variables?.text === text;
  const run = () => m.mutate({ recId: rec.id, text, changeType, targetSection, draftId: draftId ?? null }, { onSuccess: (c) => setOwn(c) });

  return (
    <div className="rounded-md border border-line2 px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h5 className="flex-1 text-[12px] font-medium">Content originality</h5>
        <Chip tone={current ? (current.status === "CHECK_FAILED" ? "coral" : "teal") : "rest"}>
          {current ? (current.status === "CHECKED" ? "checked" : "check failed") : stale ? "not checked (text changed)" : "not checked"}
        </Chip>
        {canCheck && (
          <Button variant="secondary" disabled={busy || !key} onClick={run}>
            {busy ? "Checking…" : current ? "Run check again" : "Check originality"}
          </Button>
        )}
      </div>
      {current ? (
        <OriginalityResult check={current} />
      ) : (
        <p className="text-[12px] text-ink3">
          {stale ? "The text changed after the last check, so that result no longer applies. " : ""}
          Not checked yet: nothing is known about overlap with other pages. The final text is always checked when you approve.
        </p>
      )}
      {m.variables?.recId === rec.id && <ErrorText error={m.error} />}
    </div>
  );
}

/** Shown when an approval was stopped by the originality policy. Lets the reviewer acknowledge, or explains why not. */
export function OriginalityGate({ error, pending, onAcknowledge }: { error: unknown; pending: boolean; onAcknowledge: (checkId: string) => void }) {
  const [ack, setAck] = useState(false);
  const gate = originalityFromError(error);
  if (!gate) return <ErrorText error={error} />;
  return (
    <div className="space-y-2 rounded-md border border-coral/40 bg-coral-bg/30 p-3">
      <p className="text-[12.5px]">
        {gate.code === "ORIGINALITY_ACK_REQUIRED" && "This text closely matches other pages in this project. Review the matches below. Edit the text, or acknowledge them if the overlap is legitimate."}
        {gate.code === "ORIGINALITY_BLOCKED" && "This text closely matches other pages in this project and the policy here does not allow approving it. Edit the text and try again."}
        {gate.code === "ORIGINALITY_CHECK_FAILED" && "The originality check failed, so this text cannot be approved yet. Try again."}
      </p>
      <OriginalityResult check={gate.check} />
      {gate.code === "ORIGINALITY_ACK_REQUIRED" && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-[12.5px]">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            I reviewed these matches. The overlap is legitimate (for example a business name, a standard phrase, or attributed material), and the text can go forward for approval.
          </label>
          <Button disabled={!ack || pending} onClick={() => onAcknowledge(gate.check.id)}>Acknowledge and continue</Button>
        </div>
      )}
    </div>
  );
}
