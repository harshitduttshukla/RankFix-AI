"use client";

import Link from "next/link";
import { useState } from "react";
import { pathOf } from "@/components/crawl-status";
import { OpportunityStatusChip, Score, TYPE_HINT, TYPE_LABEL, TypeChip } from "@/components/opportunity";
import { Banner, Button, Card, ErrorText, selectClass } from "@/components/ui";
import { useDetectOpportunities, useOpportunities, type OpportunityFilters } from "@/hooks/use-opportunities";
import { useCurrentProject } from "@/hooks/use-projects";
import { fmtDateTime, fmtInt, fmtPct, fmtPos } from "@/lib/format";
import type { DetectionRun, OpportunityType } from "@/lib/types";

const PAGE_SIZE = 50;

export default function OpportunitiesPage() {
  const { current } = useCurrentProject();
  const [filters, setFilters] = useState<OpportunityFilters>({ status: "open", offset: 0 });
  const list = useOpportunities(current?.id, filters);
  const detect = useDetectOpportunities(current?.id ?? "");
  const canDetect = current && current.role !== "VIEWER";
  const run = list.data?.latestRun;
  const running = run && (run.status === "QUEUED" || run.status === "RUNNING");
  const set = (patch: Partial<OpportunityFilters>) => setFilters((f) => ({ ...f, offset: 0, ...patch }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Opportunities</h1>
          <p className="mt-1 max-w-2xl text-[13.4px] text-ink2">
            Existing pages with measurable optimization potential, ranked by score. Each opportunity is detected from your stored
            Search Console data and crawled page structure by fixed rules, with the evidence shown.
          </p>
        </div>
        {canDetect && (
          <Button onClick={() => detect.mutate()} disabled={detect.isPending || Boolean(running)}>
            {running ? "Detecting…" : "Detect opportunities"}
          </Button>
        )}
      </div>

      <ErrorText error={detect.error ?? list.error} />
      {run && <RunBanner run={run} />}

      <Card
        title={list.data ? `${fmtInt(list.data.total)} ${filters.status === "open" ? "open " : ""}opportunit${list.data.total === 1 ? "y" : "ies"}` : "Opportunities"}
        action={
          <div className="flex flex-wrap gap-2">
            <select aria-label="Type" className={selectClass} value={filters.type ?? ""} onChange={(e) => set({ type: (e.target.value || undefined) as OpportunityType | undefined })}>
              <option value="">All types</option>
              {(Object.keys(TYPE_LABEL) as OpportunityType[]).map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </select>
            <select aria-label="Status" className={selectClass} value={filters.status} onChange={(e) => set({ status: e.target.value as OpportunityFilters["status"] })}>
              <option value="open">Open</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All statuses</option>
            </select>
          </div>
        }
      >
        {list.isLoading ? (
          <p className="text-[13px] text-ink3">Loading…</p>
        ) : !list.data?.items.length ? (
          <p className="text-[13px] text-ink3">
            {filters.status === "open" && !filters.type
              ? "No open opportunities. Sync Search Console data and crawl the website, then run detection."
              : "Nothing matches these filters."}
          </p>
        ) : (
          <div className="-mx-[15px] -mb-[15px] overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-left text-[13px]">
              <thead className="bg-rail text-[11.5px] text-ink3">
                <tr>
                  <th className="border-b border-line px-[11px] py-2 font-medium">Page</th>
                  <th className="border-b border-line px-[11px] py-2 font-medium">Opportunity</th>
                  <th className="border-b border-line px-[11px] py-2 font-medium">Score</th>
                  <th className="border-b border-line px-[11px] py-2 text-right font-medium">Impr.</th>
                  <th className="border-b border-line px-[11px] py-2 text-right font-medium">Clicks</th>
                  <th className="border-b border-line px-[11px] py-2 text-right font-medium">CTR</th>
                  <th className="border-b border-line px-[11px] py-2 text-right font-medium">Pos.</th>
                  <th className="border-b border-line px-[11px] py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line2">
                {list.data.items.map((o) => (
                  <tr key={o.id} className="align-top hover:bg-rail">
                    <td className="max-w-[340px] px-[11px] py-2.5">
                      <Link href={`/optimization/opportunities/${o.id}`} className="block truncate font-medium text-ink no-underline hover:text-teal" title={o.pageUrl}>
                        {o.pageTitle ?? pathOf(o.pageUrl)}
                      </Link>
                      <span className="block truncate font-mono text-[11.5px] text-ink3">{pathOf(o.pageUrl)}</span>
                      {o.reasons[0] && <span className="mt-1 block text-[12px] leading-snug text-ink2">{o.reasons[0]}</span>}
                    </td>
                    <td className="px-[11px] py-2.5" title={TYPE_HINT[o.type]}><TypeChip type={o.type} /></td>
                    <td className="px-[11px] py-2.5"><Score value={o.score} /></td>
                    <td className="px-[11px] py-2.5 text-right font-mono text-[12.2px]">{fmtInt(o.impressions)}</td>
                    <td className="px-[11px] py-2.5 text-right font-mono text-[12.2px]">{fmtInt(o.clicks)}</td>
                    <td className="px-[11px] py-2.5 text-right font-mono text-[12.2px]">{fmtPct(o.ctr)}</td>
                    <td className="px-[11px] py-2.5 text-right font-mono text-[12.2px]">{fmtPos(o.position)}</td>
                    <td className="px-[11px] py-2.5"><OpportunityStatusChip status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && list.data.total > PAGE_SIZE && (
          <div className="mt-6 flex items-center justify-between text-[12.5px] text-ink2">
            <span>
              {filters.offset + 1}–{Math.min(filters.offset + PAGE_SIZE, list.data.total)} of {fmtInt(list.data.total)}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: f.offset - PAGE_SIZE }))}>Previous</Button>
              <Button variant="secondary" disabled={filters.offset + PAGE_SIZE >= list.data.total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + PAGE_SIZE }))}>Next</Button>
            </div>
          </div>
        )}
      </Card>
      <p className="text-[12px] text-ink3">
        Scores and evidence describe measured Search Console performance. They do not establish why a page performs the way it does,
        or predict the effect of a change.
      </p>
    </div>
  );
}

function RunBanner({ run }: { run: DetectionRun }) {
  if (run.status === "QUEUED" || run.status === "RUNNING") {
    return <Banner tone="teal">Detecting opportunities{run.trigger === "GSC_SYNC" ? " after the Search Console sync" : ""}…</Banner>;
  }
  if (run.status === "FAILED") return <Banner tone="coral">Last detection failed: {run.error ?? "unknown error"}</Banner>;
  return (
    <p className="text-[12px] text-ink3">
      Last detection {fmtDateTime(run.completedAt)} · {fmtInt(run.pagesEvaluated)} pages evaluated · {run.created} new, {run.updated} refreshed, {run.cleared} no longer detected
    </p>
  );
}
