import type { OpportunityType } from '@prisma/client';
import { expectedCtr, type OpportunityConfig, type ScoreComponent } from './opportunity.config.js';
import type { PageInput, QueryAnalysis, ScoreBreakdownItem } from './opportunity.types.js';

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Percent change from previous to current (negative = decline). Null when there is no previous baseline. */
export function percentChange(previous: number, current: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Normalized (0..1) components. Each is a plain measurable quantity:
 * - impressions: log-scaled between minImpressions (0) and impressionsScaleMax (1)
 * - ctr:         relative gap below the expected CTR for the page's position
 * - position:    1 for the top of the page-one band, tapering to 0.7 at its bottom and to 0 by lowCtrMaxPosition;
 *                0.3 for positions above the band (already near the top, less room)
 * - trend:       click (or CTR) decline as a fraction of trendFullDeclinePercent
 * - query:       share of query impressions from queries ranking in the improvable range
 * - coverage:    share of query impressions from queries whose terms are absent from the page structure,
 *                where coverageFullShare earns full points
 */
export function scoreComponents(page: PageInput, qa: QueryAnalysis, cfg: OpportunityConfig): Record<ScoreComponent, number> {
  const { current, previous } = page;
  const pos = current.position;

  const impressions = clamp01(
    Math.log(Math.max(current.impressions, 1) / cfg.minImpressions) / Math.log(cfg.impressionsScaleMax / cfg.minImpressions),
  );

  const expected = pos == null ? 0 : expectedCtr(pos, cfg);
  const ctr = expected > 0 ? clamp01((expected - current.ctr) / expected) : 0;

  let position = 0;
  if (pos != null) {
    const { pageOneMinPosition: lo, pageOneMaxPosition: hi, lowCtrMaxPosition: far } = cfg;
    if (pos < lo) position = 0.3;
    else if (pos <= hi) position = 1 - (0.3 * (pos - lo)) / Math.max(hi - lo, 1);
    else if (pos < far) position = (0.7 * (far - pos)) / Math.max(far - hi, 1);
  }

  const clickChange = percentChange(previous.clicks, current.clicks);
  const ctrChange = percentChange(previous.ctr, current.ctr);
  const decline = Math.max(-(clickChange ?? 0), -(ctrChange ?? 0), 0);
  const trend = clamp01(decline / cfg.trendFullDeclinePercent);

  return {
    impressions,
    ctr,
    position: clamp01(position),
    trend,
    query: clamp01(qa.improvableShare),
    coverage: clamp01(qa.uncoveredShare / cfg.coverageFullShare),
  };
}

/** score = Σ weight(type, component) × normalized component, 0..100, with the breakdown kept for display. */
export function scoreOpportunity(
  type: OpportunityType,
  components: Record<ScoreComponent, number>,
  cfg: OpportunityConfig,
): { score: number; breakdown: ScoreBreakdownItem[] } {
  const weights = cfg.weights[type];
  const breakdown = (Object.keys(weights) as ScoreComponent[])
    .filter((c) => weights[c] > 0)
    .map((component) => ({
      component,
      value: Math.round(components[component] * 1000) / 1000,
      weight: weights[component],
      points: round1(weights[component] * components[component]),
    }))
    .sort((a, b) => b.weight - a.weight);
  const score = round1(Math.min(100, Math.max(0, breakdown.reduce((s, b) => s + b.points, 0))));
  return { score, breakdown };
}
