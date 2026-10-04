"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CrawlChip, PageStatusChip, pathOf } from "@/components/crawl-status";
import { Banner, Button, Card, ErrorText, selectClass } from "@/components/ui";
import { useCancelCrawl, useCrawlDetail, useCrawls, usePages, useStartCrawl, useWebsite } from "@/hooks/use-crawl";
import { useCurrentProject } from "@/hooks/use-projects";
import { fmtDateTime, fmtInt } from "@/lib/format";
import type { CrawlJob, PageStatus } from "@/lib/types";

const isActive = (c?: CrawlJob) => c?.status === "PENDING" || c?.status === "RUNNING";

export default function WebsitePage() {
  const { websiteId } = useParams<{ websiteId: string }>();
  const website = useWebsite(websiteId);
  const crawls = useCrawls(websiteId);
  const { current } = useCurrentProject();
  const canCrawl = current?.role !== "VIEWER";
  const latest = crawls.data?.[0];
  const qc = useQueryClient();
  const progress = `${latest?.id}:${latest?.pagesProcessed}:${latest?.status}`;
  // Pages appear as the crawl progresses.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["websites", websiteId, "pages"] });
  }, [progress, qc, websiteId]);

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1.5 text-[11.5px] text-ink3">
          <Link href="/dashboard" className="text-ink3 no-underline hover:text-ink">Dashboard</Link> / Website
        </p>
        <h1 className="font-mono text-[22px]">{website.data?.baseUrl ?? "…"}</h1>
        <p className="mt-1 text-[13.4px] text-ink2">
          Existing pages discovered from robots.txt and sitemaps
          {website.data?.blogPathPrefix ? <> · limited to <span className="font-mono">{website.data.blogPathPrefix}</span></> : null}
        </p>
      </div>
      <ErrorText error={website.error} />
      <CrawlPanel websiteId={websiteId} latest={latest} canCrawl={canCrawl} />
      {crawls.data && crawls.data.length > 1 && <CrawlHistory crawls={crawls.data} />}
      <PagesTable websiteId={websiteId} />
    </div>
  );
}

function CrawlPanel({ websiteId, latest, canCrawl }: { websiteId: string; latest?: CrawlJob; canCrawl: boolean }) {
  const start = useStartCrawl(websiteId);
  const cancel = useCancelCrawl(websiteId);
  const active = isActive(latest);
  const detail = useCrawlDetail(websiteId, latest?.id, active);
  const c = detail.data ?? latest;
  const pct = c && c.pagesDiscovered ? Math.min(100, Math.round((c.pagesProcessed / c.pagesDiscovered) * 100)) : 0;
  const [showIssues, setShowIssues] = useState(false);

  return (
    <Card
      title="Crawl"
      action={
        canCrawl ? (
          <div className="flex gap-2">
            {active && latest && (
              <Button variant="danger" disabled={cancel.isPending || Boolean(latest.cancelRequestedAt)} onClick={() => cancel.mutate(latest.id)}>
                {latest.cancelRequestedAt ? "Cancelling…" : "Cancel"}
              </Button>
            )}
            <Button disabled={active || start.isPending} onClick={() => start.mutate()}>
              {active ? "Crawling…" : "Crawl website"}
            </Button>
          </div>
        ) : null
      }
    >
      <div className="space-y-4">
        <ErrorText error={start.error ?? cancel.error} />
        {!c ? (
          <p className="text-[13px] text-ink2">Not crawled yet. Crawling reads robots.txt and your sitemap, then fetches each existing page.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <CrawlChip status={c.status} />
              <span className="text-ink2">
                {c.completedAt ? `Finished ${fmtDateTime(c.completedAt)}` : c.startedAt ? `Started ${fmtDateTime(c.startedAt)}` : "Queued"}
                {c.discoveryMethod && ` · discovered via ${c.discoveryMethod}`}
                {c.robotsFound === false && " · no robots.txt"}
              </span>
            </div>
            {active && (
              <div className="h-1.5 overflow-hidden rounded-full bg-rest-bg" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-teal transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Discovered", c.pagesDiscovered],
                ["Processed", c.pagesProcessed],
                ["Failed", c.pagesFailed],
                ["Skipped", c.pagesSkipped],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-line px-[13px] py-[11px]">
                  <dt className="text-[11.5px] text-ink3">{label}</dt>
                  <dd className={`font-mono text-[23px] tracking-[-0.02em] ${label === "Failed" && Number(value) > 0 ? "text-coral" : ""}`}>{fmtInt(Number(value))}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[12px] text-ink2">
              <span className="font-mono">{c.pagesCreated}</span> new · <span className="font-mono">{c.pagesUpdated}</span> changed ·{" "}
              <span className="font-mono">{c.pagesUnchanged}</span> unchanged · <span className="font-mono">{c.renderedPages}</span> needed JavaScript rendering
            </p>
            {c.error && <Banner tone={c.status === "FAILED" ? "coral" : "rest"}>{c.error}</Banner>}
            {detail.data && (detail.data.failures.length > 0 || detail.data.skipped.length > 0) && (
              <div>
                <button className="cursor-pointer text-[12.5px] text-teal" onClick={() => setShowIssues((v) => !v)}>
                  {showIssues ? "Hide" : "Show"} {detail.data.failures.length} failed and {detail.data.skipped.length} skipped URLs
                </button>
                {showIssues && (
                  <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-line">
                    <table className="w-full border-collapse text-left text-[12.5px]">
                      <thead className="sticky top-0 bg-rail text-[11.5px] text-ink3">
                        <tr>
                          <th className="border-b border-line px-[11px] py-2 font-medium">URL</th>
                          <th className="border-b border-line px-[11px] py-2 font-medium">Result</th>
                          <th className="border-b border-line px-[11px] py-2 font-medium">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line2">
                        {[...detail.data.failures, ...detail.data.skipped].map((r) => (
                          <tr key={`${r.outcome}-${r.url}`}>
                            <td className="max-w-xs truncate px-[11px] py-1.5 font-mono" title={r.url}>{pathOf(r.url)}</td>
                            <td className={`px-[11px] py-1.5 ${r.outcome === "FAILED" ? "text-coral" : "text-ink2"}`}>{r.outcome.toLowerCase()}</td>
                            <td className="px-[11px] py-1.5 text-ink2">
                              <span className="font-mono">{r.errorCode}</span> {r.errorMessage && r.errorMessage !== r.errorCode ? `· ${r.errorMessage}` : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function CrawlHistory({ crawls }: { crawls: CrawlJob[] }) {
  return (
    <Card title="Crawl history">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead className="bg-rail text-[11.5px] text-ink3">
            <tr>
              <th className="border-b border-line px-[11px] py-2 font-medium">Started</th>
              <th className="border-b border-line px-[11px] py-2 font-medium">Status</th>
              <th className="border-b border-line px-[11px] py-2 text-right font-medium">Processed</th>
              <th className="border-b border-line px-[11px] py-2 text-right font-medium">Changed</th>
              <th className="border-b border-line px-[11px] py-2 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line2">
            {crawls.map((c) => (
              <tr key={c.id}>
                <td className="px-[11px] py-2">{fmtDateTime(c.startedAt ?? c.createdAt)}</td>
                <td className="px-[11px] py-2"><CrawlChip status={c.status} /></td>
                <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{c.pagesProcessed}</td>
                <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{c.pagesCreated + c.pagesUpdated}</td>
                <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{c.pagesFailed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STATUSES: (PageStatus | "ALL")[] = ["ALL", "ACTIVE", "EXCLUDED", "REDIRECTED", "GONE", "ERROR"];

function PagesTable({ websiteId }: { websiteId: string }) {
  const [status, setStatus] = useState<PageStatus | "ALL">("ALL");
  const [q, setQ] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const pages = usePages(websiteId, { status: status === "ALL" ? undefined : status, q: q || undefined, cursor });

  return (
    <Card
      title="Pages"
      action={
        <div className="flex flex-wrap gap-2">
          <select aria-label="Status" className={selectClass} value={status} onChange={(e) => (setStatus(e.target.value as PageStatus | "ALL"), setCursors([]))}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "ALL" ? "All statuses" : `${s.toLowerCase()}${pages.data?.counts[s] ? ` (${pages.data.counts[s]})` : ""}`}
              </option>
            ))}
          </select>
          <input
            aria-label="Search pages"
            placeholder="Search URL or title"
            className={`${selectClass} w-48`}
            value={q}
            onChange={(e) => (setQ(e.target.value), setCursors([]))}
          />
        </div>
      }
    >
      <ErrorText error={pages.error} />
      {pages.data && pages.data.items.length === 0 ? (
        <p className="text-[13px] text-ink2">No pages yet. Run a crawl to discover existing pages.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="bg-rail text-[11.5px] text-ink3">
              <tr>
                <th className="border-b border-line px-[11px] py-2 font-medium">Page</th>
                <th className="border-b border-line px-[11px] py-2 font-medium">Status</th>
                <th className="border-b border-line px-[11px] py-2 text-right font-medium">Words</th>
                <th className="border-b border-line px-[11px] py-2 font-medium">Method</th>
                <th className="border-b border-line px-[11px] py-2 font-medium">Last crawled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line2">
              {pages.data?.items.map((p) => (
                <tr key={p.id} className="hover:bg-rail">
                  <td className="max-w-md px-[11px] py-2">
                    <Link href={`/websites/${websiteId}/pages/${p.id}`} className="block truncate font-medium text-ink no-underline hover:text-teal">
                      {p.title ?? "(no title)"}
                    </Link>
                    <span className="block truncate font-mono text-[11.5px] text-ink3" title={p.url}>{pathOf(p.url)}</span>
                  </td>
                  <td className="px-[11px] py-2"><PageStatusChip status={p.status} /></td>
                  <td className="px-[11px] py-2 text-right font-mono text-[12.2px]">{p.wordCount == null ? "—" : fmtInt(p.wordCount)}</td>
                  <td className="px-[11px] py-2 text-[12px] text-ink2">{p.extractionMethod === "PLAYWRIGHT" ? "Browser render" : p.extractionMethod ? "HTML" : "—"}</td>
                  <td className="px-[11px] py-2 text-[12px] text-ink2">{fmtDateTime(p.lastCrawledAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cursors.length > 0 || pages.data?.nextCursor) && (
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" disabled={!cursors.length} onClick={() => setCursors((c) => c.slice(0, -1))}>Previous</Button>
          <Button variant="secondary" disabled={!pages.data?.nextCursor} onClick={() => pages.data?.nextCursor && setCursors((c) => [...c, pages.data!.nextCursor!])}>Next</Button>
        </div>
      )}
    </Card>
  );
}
