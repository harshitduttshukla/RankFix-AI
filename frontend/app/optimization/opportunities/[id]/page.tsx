"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { PageStatusChip, pathOf } from "@/components/crawl-status";
import { OpportunityStatusChip, Score, TYPE_HINT, TYPE_LABEL } from "@/components/opportunity";
import { Button, Card, Chip, ErrorText } from "@/components/ui";
import { useDismissOpportunity, useOpportunity } from "@/hooks/use-opportunities";
import { useCurrentProject } from "@/hooks/use-projects";
import { fmtDateTime, fmtInt, fmtPct, fmtPos } from "@/lib/format";
import type { Evidence, OpportunityDetail, PeriodMetrics } from "@/lib/types";

const COMPONENT_LABEL: Record<string, string> = {
  impressions: "Impressions",
  ctr: "CTR gap",
  position: "Position",
  trend: "Trend",
  query: "Query ranking",
  coverage: "Query coverage",
};

export default function OpportunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { current } = useCurrentProject();
  const q = useOpportunity(current?.id, id);
  const dismiss = useDismissOpportunity(current?.id ?? "", id);
  const o = q.data;
  const canDismiss = current && current.role !== "VIEWER" && o && (o.status === "DETECTED" || o.status === "REVIEWED");

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1.5 text-[11.5px] text-ink3">
          <Link href="/optimization/opportunities" className="text-ink3 no-underline hover:text-ink">Opportunities</Link> / {o ? TYPE_LABEL[o.type] : "…"}
        </p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1>{o ? (o.page.title ?? pathOf(o.page.url)) : "…"}</h1>
            {o && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ink2">
                <a href={o.page.url} target="_blank" rel="noreferrer noopener" className="font-mono text-[12.5px]">{o.page.url}</a>
                <OpportunityStatusChip status={o.status} />
              </p>
            )}
          </div>
          {canDismiss && (
            <Button
              variant="secondary"
              disabled={dismiss.isPending}
              onClick={() => {
                const reason = window.prompt("Dismiss this opportunity? Optionally add a reason.");
                if (reason !== null) dismiss.mutate(reason.trim() || undefined);
              }}
            >
              Dismiss
            </Button>
          )}
        </div>
      </div>
      <ErrorText error={q.error ?? dismiss.error} />
      {o && (
        <>
          <div className="grid gap-[13px] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Why o={o} />
            <ScoreCard o={o} />
          </div>
          <div className="grid gap-[13px] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Performance o={o} />
            <PageCard o={o} />
          </div>
          <EvidenceCard evidence={o.evidence} />
          <Queries o={o} />
          {o.status === "DISMISSED" && (
            <p className="text-[12.5px] text-ink3">
              Dismissed {fmtDateTime(o.dismissedAt)} — {o.dismissReason === "SIGNAL_CLEARED" ? "the signal no longer held on a later detection run" : (o.dismissReason ?? "")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Why({ o }: { o: OpportunityDetail }) {
  const primary = o.evidence.filter((e) => e.primary);
  return (
    <Card title="Why this was detected">
      <p className="text-[13.4px] leading-relaxed">{o.metrics.summary}</p>
      <p className="mt-3 text-[12.5px] text-ink2"><span className="font-medium text-ink">{TYPE_LABEL[o.type]}:</span> {TYPE_HINT[o.type]}</p>
      <ul className="mt-3 space-y-1.5 text-[13px]">
        {primary.map((e, n) => (
          <li key={n} className="flex gap-2"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />{e.text}</li>
        ))}
      </ul>
      <p className="mt-4 text-[11.5px] text-ink3">
        This describes measured Search Console performance between {o.dateRangeStart} and {o.dateRangeEnd}. It does not establish a cause or predict the effect of changes.
      </p>
    </Card>
  );
}

function ScoreCard({ o }: { o: OpportunityDetail }) {
  return (
    <Card title="Opportunity score">
      <Score value={o.score} large />
      <table className="mt-4 w-full text-[12.5px]">
        <thead className="text-[11px] text-ink3">
          <tr>
            <th className="pb-1 text-left font-medium">Component</th>
            <th className="pb-1 text-right font-medium">Signal</th>
            <th className="pb-1 text-right font-medium">Points</th>
          </tr>
        </thead>
        <tbody>
          {o.scoreBreakdown.map((b) => (
            <tr key={b.component}>
              <td className="py-0.5">{COMPONENT_LABEL[b.component] ?? b.component}</td>
              <td className="py-0.5 text-right font-mono text-ink2">{Math.round(b.value * 100)}%</td>
              <td className="py-0.5 text-right font-mono">{b.points.toFixed(1)} <span className="text-ink3">/ {b.weight}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11.5px] text-ink3">Each component is normalized to 0–100% and multiplied by its weight for this opportunity type.</p>
    </Card>
  );
}

function Delta({ value, suffix = "%", invert = false }: { value: number | null; suffix?: string; invert?: boolean }) {
  if (value == null) return <span className="text-ink3">—</span>;
  const bad = invert ? value > 0 : value < 0;
  return <span className={bad ? "text-coral" : "text-ink2"}>{value > 0 ? "+" : ""}{value.toFixed(1)}{suffix}</span>;
}

function Performance({ o }: { o: OpportunityDetail }) {
  const { current: c, previous: p } = o.metrics;
  const hasPrev = p.impressions > 0;
  const row = (label: string, cur: ReactNode, prev: ReactNode, delta: ReactNode) => (
    <tr className="border-t border-line2">
      <td className="py-1.5 text-ink2">{label}</td>
      <td className="py-1.5 text-right font-mono">{cur}</td>
      <td className="py-1.5 text-right font-mono text-ink2">{hasPrev ? prev : "—"}</td>
      <td className="py-1.5 text-right font-mono">{hasPrev ? delta : "—"}</td>
    </tr>
  );
  const range = (m: PeriodMetrics) => `${m.start} → ${m.end}`;
  return (
    <Card title="Search Console performance">
      <table className="w-full text-[13px]">
        <thead className="text-[11px] text-ink3">
          <tr>
            <th className="pb-1 text-left font-medium" />
            <th className="pb-1 text-right font-medium">Current<br /><span className="font-normal">{range(c)}</span></th>
            <th className="pb-1 text-right font-medium">Previous<br /><span className="font-normal">{range(p)}</span></th>
            <th className="pb-1 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {row("Clicks", fmtInt(c.clicks), fmtInt(p.clicks), <Delta value={o.metrics.clickChangePercent} />)}
          {row("Impressions", fmtInt(c.impressions), fmtInt(p.impressions), <Delta value={p.impressions ? ((c.impressions - p.impressions) / p.impressions) * 100 : null} />)}
          {row("CTR", fmtPct(c.ctr), fmtPct(p.ctr), <Delta value={o.metrics.ctrChangePercent} />)}
          {row("Average position", fmtPos(c.position), fmtPos(p.position), <Delta value={o.metrics.positionChange} suffix="" invert />)}
        </tbody>
      </table>
      <p className="mt-3 text-[11.5px] text-ink3">
        {o.metrics.expectedCtr != null && <>Typical CTR at this position ≈ {fmtPct(o.metrics.expectedCtr)}. </>}
        {fmtInt(o.metrics.queryCount)} queries recorded. CTR is clicks ÷ impressions; position is impression-weighted.
      </p>
    </Card>
  );
}

function PageCard({ o }: { o: OpportunityDetail }) {
  const p = o.page;
  return (
    <Card title="Page" action={<Link href={`/websites/${p.websiteId}/pages/${p.id}`} className="text-[12.5px]">Crawled content →</Link>}>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-ink3">URL</dt>
        <dd className="m-0 break-all font-mono text-[12px]">{pathOf(p.url)}</dd>
        <dt className="text-ink3">Title</dt>
        <dd className="m-0">{p.title ?? <span className="text-coral">missing</span>}</dd>
        <dt className="text-ink3">H1</dt>
        <dd className="m-0">{p.h1 ?? <span className="text-coral">missing</span>}</dd>
        <dt className="text-ink3">Words</dt>
        <dd className="m-0 font-mono">{p.wordCount != null ? fmtInt(p.wordCount) : "—"}</dd>
        <dt className="text-ink3">Status</dt>
        <dd className="m-0"><PageStatusChip status={p.status} /></dd>
        <dt className="text-ink3">Last crawled</dt>
        <dd className="m-0">{fmtDateTime(p.lastCrawledAt)}</dd>
      </dl>
    </Card>
  );
}

function fmtEvidence(e: Evidence, v: number | undefined) {
  if (v == null) return "—";
  if (e.unit === "percent") return `${v.toFixed(2)}%`;
  if (e.unit === "position") return v.toFixed(1);
  return fmtInt(v);
}

function thresholdText(e: Evidence) {
  if (e.threshold == null) return "—";
  if (e.comparison === "between") return `${fmtEvidence(e, e.threshold)}–${fmtEvidence(e, e.thresholdMax)}`;
  if (e.type === "CLICK_DECLINE" || e.type === "CTR_DECLINE") return `≥ ${Math.abs(e.threshold)}% drop`;
  if (e.type === "POSITION_CHANGE") return `≥ ${e.threshold} places`;
  return `${e.comparison === "<" ? "<" : "≥"} ${fmtEvidence(e, e.threshold)}`;
}

function EvidenceCard({ evidence }: { evidence: Evidence[] }) {
  return (
    <Card title="Evidence">
      <div className="-mx-[15px] -mb-[15px] overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-[12.5px]">
          <thead className="bg-rail text-[11.5px] text-ink3">
            <tr>
              <th className="border-b border-line px-[11px] py-2 font-medium">Signal</th>
              <th className="border-b border-line px-[11px] py-2 text-right font-medium">Value</th>
              <th className="border-b border-line px-[11px] py-2 text-right font-medium">Previous</th>
              <th className="border-b border-line px-[11px] py-2 text-right font-medium">Threshold</th>
              <th className="border-b border-line px-[11px] py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line2">
            {evidence.map((e, n) => (
              <tr key={n} className="align-top">
                <td className="whitespace-nowrap px-[11px] py-2">
                  <span className="font-mono text-[11.5px]">{e.type}</span>
                  {e.primary && <span className="ml-1.5"><Chip tone="coral">trigger</Chip></span>}
                </td>
                <td className="px-[11px] py-2 text-right font-mono">{fmtEvidence(e, e.value)}</td>
                <td className="px-[11px] py-2 text-right font-mono text-ink2">{fmtEvidence(e, e.previousValue)}</td>
                <td className="whitespace-nowrap px-[11px] py-2 text-right font-mono text-ink2">{thresholdText(e)}</td>
                <td className="px-[11px] py-2 text-ink2">{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Queries({ o }: { o: OpportunityDetail }) {
  return (
    <Card title={`Top queries (${o.topQueries.length} of ${fmtInt(o.metrics.queryCount)})`}>
      {o.topQueries.length ? (
        <div className="-mx-[15px] -mb-[15px] overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="bg-rail text-[11.5px] text-ink3">
              <tr>
                <th className="border-b border-line px-[11px] py-2 font-medium">Query</th>
                <th className="border-b border-line px-[11px] py-2 text-right font-medium">Clicks</th>
                <th className="border-b border-line px-[11px] py-2 text-right font-medium">Impr.</th>
                <th className="border-b border-line px-[11px] py-2 text-right font-medium">CTR</th>
                <th className="border-b border-line px-[11px] py-2 text-right font-medium">Pos.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line2">
              {o.topQueries.map((q) => (
                <tr key={q.query} className="hover:bg-rail">
                  <td className="px-[11px] py-2">{q.query}</td>
                  <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{fmtInt(q.clicks)}</td>
                  <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{fmtInt(q.impressions)}</td>
                  <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{fmtPct(q.ctr)}</td>
                  <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{fmtPos(q.position)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[13px] text-ink3">Search Console reported no individual queries for this page in the period.</p>
      )}
    </Card>
  );
}
