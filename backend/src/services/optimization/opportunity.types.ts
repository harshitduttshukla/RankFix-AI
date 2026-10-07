import type { OpportunityType } from '@prisma/client';
import type { ScoreComponent } from './opportunity.config.js';

/** Page-level GSC totals for one window. ctr = clicks / impressions; position is impression-weighted. */
export interface PeriodMetrics {
  start: string; // YYYY-MM-DD
  end: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export interface QueryMetrics {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

/** Structural text of the page's current crawled version (no body text: coverage is judged on structure). */
export interface PageStructure {
  title: string | null;
  h1: string | null;
  headings: string[];
}

/** Everything the pure detector needs for one existing page. Built only from stored GSC + crawler data. */
export interface PageInput {
  pageId: string;
  url: string;
  title: string | null;
  current: PeriodMetrics;
  previous: PeriodMetrics;
  queryCount: number;
  /** Ranked (impressions desc, clicks desc, query) current-window queries. */
  queries: QueryMetrics[];
  structure: PageStructure | null;
}

export type EvidenceType =
  | 'HIGH_IMPRESSIONS'
  | 'LOW_CTR'
  | 'PAGE_ONE_RANKING'
  | 'HIGH_QUERY_IMPRESSIONS'
  | 'CLICK_DECLINE'
  | 'CTR_DECLINE'
  | 'POSITION_CHANGE'
  | 'QUERY_CONCENTRATION'
  | 'CONTENT_COVERAGE_SIGNAL';

export type EvidenceUnit = 'count' | 'percent' | 'position';

export interface Evidence {
  type: EvidenceType;
  /** True for the evidence that triggered this opportunity type; the rest is supporting context. */
  primary: boolean;
  metric: string;
  unit: EvidenceUnit;
  value: number;
  threshold?: number;
  /** How value relates to threshold when the evidence fired. */
  comparison?: '<' | '>=' | 'between';
  /** Upper bound for `between`. */
  thresholdMax?: number;
  previousValue?: number;
  query?: string;
  missingTerms?: string[];
  text: string;
}

export interface ScoreBreakdownItem {
  component: ScoreComponent;
  /** Normalized 0..1 */
  value: number;
  weight: number;
  points: number;
}

export interface CoverageGap {
  query: string;
  impressions: number;
  clicks: number;
  position: number | null;
  terms: string[];
  missingTerms: string[];
  coveredRatio: number;
}

export interface QueryAnalysis {
  queries: QueryMetrics[];
  totalQueryImpressions: number;
  /** Share of query impressions held by queries ranking in the improvable range. */
  improvableShare: number;
  topQueryShare: number;
  coverageGaps: CoverageGap[];
  uncoveredShare: number;
}

export interface DetectedOpportunity {
  type: OpportunityType;
  score: number;
  scoreBreakdown: ScoreBreakdownItem[];
  evidence: Evidence[];
  metrics: OpportunityMetrics;
  topQueries: QueryMetrics[];
}

export interface OpportunityMetrics {
  current: PeriodMetrics;
  previous: PeriodMetrics;
  expectedCtr: number | null;
  queryCount: number;
  clickChangePercent: number | null;
  ctrChangePercent: number | null;
  positionChange: number | null;
  coverageGaps: CoverageGap[];
  /** Neutral one-sentence description of the measured performance. */
  summary: string;
}
