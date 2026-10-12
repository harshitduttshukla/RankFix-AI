import type { ReactNode } from "react";
import { LogoMark } from "./logo";

/*
 * Product mockups for the marketing page. Static, illustrative interface compositions (no live data, no JS).
 * Every frame is labeled as an illustrative demo; numbers are examples, not customer results.
 */

export function DemoTag({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-lp-line bg-white px-2 py-0.5 text-[11px] font-medium text-lp-ink3 ${className}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-brand-violet" aria-hidden="true" />
      Illustrative demo
    </span>
  );
}

/** App window chrome around a mockup. */
export function Frame({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <figure className={`overflow-hidden rounded-2xl border border-lp-line bg-white shadow-frame ${className}`}>
      <div className="flex items-center gap-3 border-b border-lp-line2 bg-[#fbfaf8] px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#e4e1d9]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#e4e1d9]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#e4e1d9]" />
        </span>
        <figcaption className="truncate text-[12px] font-medium text-lp-ink3">{title}</figcaption>
        <DemoTag className="ml-auto" />
      </div>
      {children}
    </figure>
  );
}

function Sparkline({ points, className = "" }: { points: number[]; className?: string }) {
  const max = Math.max(...points);
  const min = Math.min(...points);
  // A floor on the vertical range keeps near-flat series looking flat instead of exaggerating noise.
  const range = Math.max(max - min, max * 0.5) || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${28 - ((p - min) / range) * 24}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={`h-7 w-full ${className}`} aria-hidden="true">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Metric({ label, value, note, points, tone = "text-brand" }: { label: string; value: string; note: string; points: number[]; tone?: string }) {
  return (
    <div className="rounded-xl border border-lp-line2 bg-white p-3">
      <p className="text-[11px] font-medium text-lp-ink3">{label}</p>
      <p className="mt-0.5 font-display text-[20px] font-semibold tabular-nums tracking-[-0.02em] text-lp-ink">{value}</p>
      <Sparkline points={points} className={`mt-1 ${tone}`} />
      <p className="mt-0.5 text-[10.5px] text-lp-ink3">{note}</p>
    </div>
  );
}

function Badge({ children, tone = "brand" }: { children: ReactNode; tone?: "brand" | "warn" | "good" | "muted" }) {
  const cls = {
    brand: "bg-brand-soft text-brand-dark",
    warn: "bg-lp-warn-bg text-lp-warn",
    good: "bg-lp-good-bg text-lp-good",
    muted: "bg-lp-bg2 text-lp-ink2",
  }[tone];
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function Btn({ children, primary = false }: { children: ReactNode; primary?: boolean }) {
  return (
    <span className={`inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-semibold ${primary ? "bg-lp-ink text-white" : "border border-lp-line bg-white text-lp-ink2"}`}>
      {children}
    </span>
  );
}

const CURRENT_META = "Scaffolding rental services.";
const PROPOSED_META = "Explore scaffolding rental services in Mumbai, including H-frame and Cuplock options.";

/** Hero composition: search data → opportunity → AI draft → human review, in one product screen. */
export function HeroPreview() {
  const steps = ["Search data", "Opportunity", "AI draft", "Human review"];
  return (
    <Frame title="RankFix AI — Opportunities · Scaffolding Rental Mumbai">
      <div className="grid md:grid-cols-[190px_1fr]">
        <aside className="hidden border-r border-lp-line2 bg-[#fbfaf8] p-4 md:block" aria-hidden="true">
          <div className="flex items-center gap-2">
            <LogoMark className="h-5 w-5" />
            <span className="text-[12.5px] font-semibold text-lp-ink">RankFix AI</span>
          </div>
          <p className="mt-5 text-[10.5px] font-medium uppercase tracking-wide text-lp-ink3">Project</p>
          <p className="mt-1 rounded-md border border-lp-line bg-white px-2 py-1.5 text-[12px] text-lp-ink">Scaffolding Rental Mumbai</p>
          <ul className="mt-5 space-y-1 text-[12.5px]">
            <li className="rounded-md px-2 py-1.5 text-lp-ink2">Dashboard</li>
            <li className="rounded-md bg-white px-2 py-1.5 font-semibold text-lp-ink shadow-card">Opportunities</li>
            <li className="rounded-md px-2 py-1.5 text-lp-ink2">Search Console</li>
          </ul>
        </aside>

        <div className="min-w-0 p-4 sm:p-5">
          <ol className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px] font-medium" aria-label="Workflow shown in this preview">
            {steps.map((s, i) => (
              <li key={s} className="flex items-center gap-1.5">
                <span className={`rounded-md px-2 py-1 ${i === 3 ? "bg-lp-ink text-white" : "bg-lp-bg2 text-lp-ink2"}`}>
                  <span className="tabular-nums opacity-60">{i + 1}</span> {s}
                </span>
                {i < steps.length - 1 && <span className="text-lp-ink3" aria-hidden="true">→</span>}
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="font-display text-[15px] font-semibold text-lp-ink">/scaffolding-rental-mumbai</p>
            <p className="text-[11.5px] text-lp-ink3">Last 28 days · Google Search Console</p>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <Metric label="Impressions" value="12,400" note="+18% vs previous" points={[6, 7, 7, 9, 8, 10, 11, 12]} />
            <Metric label="Clicks" value="124" note="flat vs previous" points={[6, 6, 6.2, 6.1, 6, 6.2, 6.1, 6.1]} tone="text-lp-ink3" />
            <Metric label="CTR" value="1.0%" note="expected ≈ 3% at this position" points={[9, 8, 8, 7, 6, 6, 5, 5]} tone="text-lp-warn" />
            <Metric label="Avg. position" value="8.6" note="page one" points={[5, 6, 6, 7, 7, 8, 8, 8]} />
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.15fr]">
            <div className="rounded-xl border border-lp-line2 p-3.5">
              <div className="flex items-center gap-2">
                <Badge tone="warn">High impressions, low CTR</Badge>
                <span className="ml-auto text-[11px] font-semibold tabular-nums text-lp-ink2">Score 81</span>
              </div>
              <p className="mt-2.5 text-[11px] font-semibold uppercase tracking-wide text-brand">AI analysis</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-lp-ink2">
                The page receives search impressions, but its click-through rate is relatively low for its current position. Review the search snippet for clarity and relevance.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Badge tone="muted">query: scaffolding rental services</Badge>
                <Badge tone="muted">CTR 1.0% at pos. 8.6</Badge>
              </div>
            </div>

            <div className="rounded-xl border border-lp-line2 p-3.5">
              <div className="flex items-center gap-2">
                <p className="text-[12.5px] font-semibold text-lp-ink">Meta description</p>
                <Badge>AI draft · validated</Badge>
              </div>
              <div className="mt-2.5 space-y-2">
                <div>
                  <p className="text-[10.5px] font-medium uppercase tracking-wide text-lp-ink3">Current</p>
                  <p className="mt-0.5 rounded-lg bg-lp-bg2 px-2.5 py-1.5 text-[12.5px] text-lp-ink2 line-through decoration-lp-ink3/50">{CURRENT_META}</p>
                </div>
                <div>
                  <p className="text-[10.5px] font-medium uppercase tracking-wide text-lp-ink3">Proposed</p>
                  <p className="mt-0.5 rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-1.5 text-[12.5px] text-lp-ink">{PROPOSED_META}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Btn primary>Approve</Btn>
                <Btn>Edit</Btn>
                <Btn>Reject</Btn>
                <span className="text-[11px] text-lp-ink3">Awaiting your review · nothing published</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

const OPPS = [
  { page: "/scaffolding-rental-mumbai", type: "High impressions, low clicks", score: 81, impr: "12,400", ctr: "1.0%", pos: "8.6", tone: "warn" as const },
  { page: "/h-frame-scaffolding", type: "Low CTR", score: 74, impr: "5,860", ctr: "0.9%", pos: "6.2", tone: "warn" as const },
  { page: "/cuplock-scaffolding-rental", type: "Near the top of page one", score: 69, impr: "3,210", ctr: "2.4%", pos: "4.7", tone: "brand" as const },
  { page: "/scaffolding-safety-checklist", type: "Performance decline", score: 63, impr: "2,940", ctr: "1.6%", pos: "11.3", tone: "muted" as const },
  { page: "/ms-scaffolding-pipes", type: "Content coverage signal", score: 52, impr: "1,780", ctr: "1.8%", pos: "9.9", tone: "muted" as const },
];

export function OpportunityTableMock() {
  return (
    <Frame title="Opportunities · ranked by evidence">
      <ul className="divide-y divide-lp-line2 px-4 py-2 sm:hidden">
        {OPPS.map((o) => (
          <li key={o.page} className="py-2.5">
            <div className="flex items-center gap-2">
              <span className="truncate text-[12.5px] font-medium text-lp-ink">{o.page}</span>
              <span className="ml-auto text-[12.5px] font-semibold tabular-nums text-lp-ink">{o.score}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-lp-ink3">
              <Badge tone={o.tone}>{o.type}</Badge>
              <span className="tabular-nums">CTR {o.ctr} · pos. {o.pos}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto p-5 sm:block">
        <table className="w-full min-w-[600px] text-left text-[12.5px]">
          <thead className="text-[11px] text-lp-ink3">
            <tr>
              <th scope="col" className="pb-2 font-medium">Page</th>
              <th scope="col" className="pb-2 font-medium">Signal</th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">Impr.</th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">CTR</th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">Pos.</th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-lp-line2">
            {OPPS.map((o) => (
              <tr key={o.page}>
                <td className="whitespace-nowrap py-2.5 pr-4 font-medium text-lp-ink">{o.page}</td>
                <td className="whitespace-nowrap py-2.5 pr-3"><Badge tone={o.tone}>{o.type}</Badge></td>
                <td className="py-2.5 pl-4 text-right tabular-nums text-lp-ink2">{o.impr}</td>
                <td className="py-2.5 pl-4 text-right tabular-nums text-lp-ink2">{o.ctr}</td>
                <td className="py-2.5 pl-4 text-right tabular-nums text-lp-ink2">{o.pos}</td>
                <td className="py-2.5 pl-4 text-right">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-12 overflow-hidden rounded-full bg-lp-bg2" aria-hidden="true">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${o.score}%` }} />
                    </span>
                    <span className="font-semibold tabular-nums text-lp-ink">{o.score}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

export function AnalysisMock() {
  return (
    <Frame title="AI analysis · /scaffolding-rental-mumbai">
      <div className="space-y-4 p-4 sm:p-5 text-[12.5px]">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-lp-ink3">Observations · what the data shows</p>
          <ul className="mt-2 space-y-2">
            <li className="flex gap-2"><Badge tone="muted">CTR</Badge><span className="text-lp-ink2">CTR is 1.0% at an average position of 8.6.</span></li>
            <li className="flex gap-2"><Badge tone="muted">Query</Badge><span className="text-lp-ink2">“scaffolding rental services” has the most impressions and no clicks.</span></li>
            <li className="flex gap-2"><Badge tone="muted">Metadata</Badge><span className="text-lp-ink2">The meta description does not mention Mumbai or the systems the page offers.</span></li>
          </ul>
        </div>
        <div className="rounded-xl border border-lp-line2 bg-[#fbfaf8] p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">Interpretation · hedged, with confidence</p>
          <p className="mt-1 text-lp-ink2">The snippet may not reflect what searchers are looking for, which could be one factor in the low CTR.</p>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-lp-ink3">
            confidence
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-lp-line2" aria-hidden="true"><span className="block h-full w-[45%] rounded-full bg-brand-violet" /></span>
            45%
          </div>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-lp-ink3">Search intent</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>scaffolding rental services · commercial</Badge>
            <Badge>scaffolding on rent in mumbai · transactional</Badge>
          </div>
        </div>
      </div>
    </Frame>
  );
}

export function DraftEditorMock() {
  return (
    <Frame title="Draft · Page title">
      <div className="grid gap-px bg-lp-line2 sm:grid-cols-2">
        <div className="bg-white p-4 sm:p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-lp-ink3">Current</p>
          <p className="mt-2 font-display text-[16px] font-semibold leading-snug text-lp-ink2">Scaffolding Rental | Home</p>
          <p className="mt-3 text-[11.5px] text-lp-ink3">24 characters</p>
        </div>
        <div className="bg-white p-4 sm:p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">Proposed · AI draft</p>
          <p className="mt-2 font-display text-[16px] font-semibold leading-snug text-lp-ink">Scaffolding Rental in Mumbai: H-frame &amp; Cuplock</p>
          <p className="mt-3 text-[11.5px] text-lp-ink3">48 characters · within limit</p>
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-lp-line2 px-4 py-3 text-[11.5px] text-lp-ink2 sm:px-5">
        <li><span className="text-lp-good">✓</span> Facts found on the page</li>
        <li><span className="text-lp-good">✓</span> No prices or claims added</li>
        <li><span className="text-lp-good">✓</span> Length within limit</li>
        <li><span className="text-lp-good">✓</span> No promissory wording</li>
      </ul>
    </Frame>
  );
}

export function ReviewMock() {
  return (
    <Frame title="Review · Meta description">
      <div className="space-y-3 p-4 sm:p-5 text-[12.5px]">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-lp-ink3">Proposed value · editable</span>
          <span className="mt-1.5 block rounded-lg border border-brand/40 bg-white px-3 py-2 text-lp-ink ring-2 ring-brand/10">
            {PROPOSED_META}
          </span>
        </div>
        <p className="text-[11.5px] text-lp-ink3">Pre-filled with the AI draft. The proposal records whether you changed it.</p>
        <div className="flex flex-wrap gap-2">
          <Btn primary>Approve &amp; create proposal</Btn>
          <Btn>Request new draft</Btn>
          <Btn>Reject</Btn>
        </div>
        <ol className="space-y-2 border-t border-lp-line2 pt-3">
          {[
            ["rev 2", "Human-edited", "Awaiting approval", "brand"],
            ["rev 1", "Unedited AI draft", "Superseded", "muted"],
          ].map(([rev, src, status, tone]) => (
            <li key={rev} className="flex flex-wrap items-center gap-2 text-[11.5px]">
              <span className="font-semibold tabular-nums text-lp-ink">{rev}</span>
              <span className="text-lp-ink2">{src}</span>
              <span className="text-lp-ink3">· page version v3</span>
              <span className="ml-auto"><Badge tone={tone as "brand" | "muted"}>{status}</Badge></span>
            </li>
          ))}
        </ol>
      </div>
    </Frame>
  );
}

export function OriginalityMock() {
  return (
    <Frame title="Content originality · this project’s pages">
      <div className="space-y-3 p-4 sm:p-5 text-[12.5px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="muted">Checked</Badge>
          <span className="text-lp-ink2">Minor overlap (short shared phrase)</span>
        </div>
        <div className="rounded-xl border border-lp-line2 p-3">
          <p className="rounded bg-lp-bg2 px-2 py-1 text-lp-ink">“H-frame, MS H-frame and Cuplock scaffolding”</p>
          <p className="mt-2 text-[11.5px] text-lp-ink2">7 words also appear in the meta description of the homepage. Often shared terminology; shown for review, not a concern on its own.</p>
        </div>
        <p className="text-[11px] text-lp-ink3">Compared with this project’s crawled pages only. Not a web plagiarism search and not proof of originality.</p>
      </div>
    </Frame>
  );
}

/** Small per-step visuals for "How it works". */
export function StepVisual({ step }: { step: 1 | 2 | 3 | 4 }) {
  const box = "rounded-xl border border-lp-line bg-white p-4 shadow-card text-[12px]";
  if (step === 1)
    return (
      <div className={box}>
        <p className="font-semibold text-lp-ink">Google Search Console</p>
        <p className="mt-1 text-lp-ink3">Read-only access</p>
        <div className="mt-3 flex items-center justify-between rounded-lg border border-lp-line2 px-3 py-2">
          <span className="text-lp-ink2">sc-domain:example.com</span>
          <Badge tone="good">Connected</Badge>
        </div>
        <p className="mt-2 text-[11px] text-lp-ink3">Last sync · 28 days of page and query data</p>
      </div>
    );
  if (step === 2)
    return (
      <div className={box}>
        <p className="font-semibold text-lp-ink">5 opportunities found</p>
        <ul className="mt-2.5 space-y-1.5">
          {OPPS.slice(0, 3).map((o) => (
            <li key={o.page} className="flex items-center gap-2">
              <span className="truncate text-lp-ink2">{o.page}</span>
              <span className="ml-auto font-semibold tabular-nums text-lp-ink">{o.score}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  if (step === 3)
    return (
      <div className={box}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">AI draft · meta description</p>
        <p className="mt-1.5 leading-relaxed text-lp-ink">{PROPOSED_META}</p>
        <p className="mt-2 text-[11px] text-lp-ink3">✓ grounded in page facts · ✓ length · ✓ no overclaims</p>
      </div>
    );
  return (
    <div className={box}>
      <p className="font-semibold text-lp-ink">Proposal · rev 1</p>
      <p className="mt-1 text-lp-ink3">Bound to page version v3</p>
      <div className="mt-3 flex gap-2">
        <Btn primary>Approve</Btn>
        <Btn>Edit</Btn>
        <Btn>Reject</Btn>
      </div>
    </div>
  );
}
