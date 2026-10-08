import type { ProposalChangeType } from '@prisma/client';

/** All Phase 6 thresholds. Deterministic; no AI involved in staleness or approval decisions. */
export const REVIEW_CONFIG = {
  /** Evidence staleness: relative change in current-window impressions/clicks vs the analysis snapshot. */
  evidenceChangeRatio: 0.3,
  /** Relative checks only apply above these baselines (small numbers swing too much). */
  minImpressionsBaseline: 100,
  minClicksBaseline: 20,
  /** Absolute change in average position that makes evidence stale. */
  positionChange: 2,
  /** Max length of a proposed value, by change type. */
  maxLength: {
    TITLE: 200,
    META_DESCRIPTION: 400,
    H1: 200,
    SECTION_HEADING: 200,
    SECTION_CONTENT: 20_000,
  } satisfies Record<ProposalChangeType, number>,
};
