import { REVIEW_CONFIG } from './review.config.js';

export type StaleReason = 'PAGE_VERSION_CHANGED' | 'EVIDENCE_CHANGED';

export interface EvidenceSnapshot {
  dateRangeEnd: string;
  score: number;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

/** Rounded so thresholds behave at their exact boundary despite floating-point error (9.2 − 7.2 ≠ 2). */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const relChange = (before: number, after: number) => r6(Math.abs(after - before) / before);

/**
 * Deterministic staleness of an analysis:
 * - PAGE_VERSION_CHANGED: the page's current version is not the version the analysis read.
 * - EVIDENCE_CHANGED: the opportunity was re-detected since and its impressions or clicks moved by
 *   ≥ 30% (above small-number baselines) or its average position moved by ≥ 2 places.
 */
export function evaluateStaleness(input: {
  analysisPageVersionId: string | null;
  currentPageVersionId: string | null;
  snapshot: EvidenceSnapshot | null;
  opportunity: { clicks: number; impressions: number; position: number };
}, cfg = REVIEW_CONFIG): StaleReason | null {
  if (input.analysisPageVersionId !== input.currentPageVersionId) return 'PAGE_VERSION_CHANGED';
  const s = input.snapshot;
  if (!s) return null;
  const o = input.opportunity;
  if (s.impressions >= cfg.minImpressionsBaseline && relChange(s.impressions, o.impressions) >= cfg.evidenceChangeRatio) return 'EVIDENCE_CHANGED';
  if (s.clicks >= cfg.minClicksBaseline && relChange(s.clicks, o.clicks) >= cfg.evidenceChangeRatio) return 'EVIDENCE_CHANGED';
  if (s.position != null && r6(Math.abs(o.position - s.position)) >= cfg.positionChange) return 'EVIDENCE_CHANGED';
  return null;
}
