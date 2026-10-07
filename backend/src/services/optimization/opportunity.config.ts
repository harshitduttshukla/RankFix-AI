import type { OpportunityType } from '@prisma/client';
import { env } from '../../config/env.js';

/**
 * Every Opportunity Engine threshold and weight lives here. Services receive an OpportunityConfig;
 * none of them hardcode a number. Env vars override the most commonly tuned values.
 */
export interface OpportunityConfig {
  /** Current evaluation window length; the previous window has the same length, immediately before. */
  windowDays: number;
  /** Page-level impressions in the current window below which a page is not evaluated at all. */
  minImpressions: number;

  /** LOW_CTR: ctr < expectedCtr(position) * lowCtrRatio, for pages at or above lowCtrMaxPosition. */
  lowCtrRatio: number;
  lowCtrMaxPosition: number;
  lowCtrMinImpressions: number;

  /** PAGE_ONE_NEAR_TOP: average position within [pageOneMinPosition, pageOneMaxPosition]. */
  pageOneMinPosition: number;
  pageOneMaxPosition: number;
  pageOneMinImpressions: number;

  /** HIGH_IMPRESSIONS_LOW_CLICKS: impressions >= highImpressions and absolute ctr < highImpressionsMaxCtr. */
  highImpressions: number;
  highImpressionsMaxCtr: number;

  /** PERFORMANCE_DECLINE: clicks (or CTR) down by at least minDeclinePercent vs the previous window. */
  minDeclinePercent: number;
  declineMinPreviousClicks: number;
  declineMinPreviousImpressions: number;
  /** Position worsening (in places) reported as POSITION_CHANGE evidence. */
  positionChangeMin: number;

  /** CONTENT_COVERAGE_SIGNAL: queries with >= minQueryImpressions whose terms are mostly absent from title/H1/headings. */
  minQueryImpressions: number;
  coverageMinTermRatio: number;
  coverageMaxQueries: number;
  /** Uncovered queries holding this share of query impressions earn full coverage points. */
  coverageFullShare: number;

  /** QUERY_CONCENTRATION evidence: the top query's share of query impressions. */
  queryConcentrationShare: number;

  /** Queries stored per opportunity and examined per page. */
  topQueriesLimit: number;
  /** Pages evaluated per database batch. */
  batchSize: number;
  /** A user dismissal suppresses re-detection of the same (page, type) for this many days. */
  dismissSnoozeDays: number;

  /** Impressions scale for the impression score: minImpressions → 0, impressionsScaleMax → 1 (log scale). */
  impressionsScaleMax: number;
  /** Click decline that earns the full trend score. */
  trendFullDeclinePercent: number;

  /** Approximate organic CTR by position, linearly interpolated. Used only as a comparison baseline. */
  expectedCtrCurve: [position: number, ctr: number][];

  /** Points per score component, by opportunity type. Each row sums to 100. */
  weights: Record<OpportunityType, Record<ScoreComponent, number>>;
}

export type ScoreComponent = 'impressions' | 'ctr' | 'position' | 'trend' | 'query' | 'coverage';

export function opportunityConfig(overrides: Partial<OpportunityConfig> = {}): OpportunityConfig {
  return {
    windowDays: env.OPPORTUNITY_WINDOW_DAYS,
    minImpressions: env.OPPORTUNITY_MIN_IMPRESSIONS,
    lowCtrRatio: env.OPPORTUNITY_LOW_CTR_RATIO,
    lowCtrMaxPosition: env.OPPORTUNITY_LOW_CTR_MAX_POSITION,
    lowCtrMinImpressions: env.OPPORTUNITY_LOW_CTR_MIN_IMPRESSIONS,
    pageOneMinPosition: env.OPPORTUNITY_PAGE_ONE_MIN_POSITION,
    pageOneMaxPosition: env.OPPORTUNITY_PAGE_ONE_MAX_POSITION,
    pageOneMinImpressions: env.OPPORTUNITY_PAGE_ONE_MIN_IMPRESSIONS,
    highImpressions: env.OPPORTUNITY_HIGH_IMPRESSIONS,
    highImpressionsMaxCtr: env.OPPORTUNITY_HIGH_IMPRESSIONS_MAX_CTR,
    minDeclinePercent: env.OPPORTUNITY_MIN_DECLINE_PERCENT,
    declineMinPreviousClicks: 50,
    declineMinPreviousImpressions: 1000,
    positionChangeMin: 1,
    minQueryImpressions: env.OPPORTUNITY_MIN_QUERY_IMPRESSIONS,
    coverageMinTermRatio: 0.5,
    coverageMaxQueries: 5,
    coverageFullShare: 0.5,
    queryConcentrationShare: 0.5,
    topQueriesLimit: 25,
    batchSize: 200,
    dismissSnoozeDays: 28,
    impressionsScaleMax: 100_000,
    trendFullDeclinePercent: 60,
    expectedCtrCurve: [
      [1, 0.28], [2, 0.15], [3, 0.11], [4, 0.08], [5, 0.06], [6, 0.05], [7, 0.04],
      [8, 0.032], [9, 0.028], [10, 0.025], [15, 0.01], [20, 0.006], [50, 0.002],
    ],
    weights: {
      LOW_CTR: { ctr: 35, impressions: 25, position: 20, trend: 10, query: 10, coverage: 0 },
      PAGE_ONE_NEAR_TOP: { position: 35, impressions: 25, ctr: 15, query: 15, trend: 10, coverage: 0 },
      HIGH_IMPRESSIONS_LOW_CLICKS: { impressions: 35, ctr: 30, query: 15, position: 10, trend: 10, coverage: 0 },
      PERFORMANCE_DECLINE: { trend: 40, impressions: 25, ctr: 15, position: 10, query: 10, coverage: 0 },
      CONTENT_COVERAGE_SIGNAL: { coverage: 40, impressions: 25, position: 15, ctr: 10, trend: 10, query: 0 },
    },
    ...overrides,
  };
}

/** Expected CTR at an average position, linearly interpolated over the configured curve. */
export function expectedCtr(position: number, cfg: Pick<OpportunityConfig, 'expectedCtrCurve'>): number {
  const curve = cfg.expectedCtrCurve;
  if (position <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [p1, c1] = curve[i]!;
    if (position <= p1) {
      const [p0, c0] = curve[i - 1]!;
      return c0 + ((position - p0) / (p1 - p0)) * (c1 - c0);
    }
  }
  return curve[curve.length - 1]![1];
}
