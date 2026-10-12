import { env } from '../../config/env.js';
import type { MatchConfig } from './fingerprint.js';

export type OriginalityPolicy = 'off' | 'warn' | 'require_ack' | 'block';

export interface OriginalityConfig {
  checker: 'internal' | 'none';
  policy: OriginalityPolicy;
  /** A failed check blocks approval (it is never treated as "no matches"). */
  requireCheck: boolean;
  match: MatchConfig;
  maxCorpusPages: number;
  resultTtlMs: number;
}

export function originalityConfig(source: typeof env = env): OriginalityConfig {
  return {
    checker: source.ORIGINALITY_CHECKER,
    policy: source.ORIGINALITY_POLICY,
    requireCheck: source.ORIGINALITY_REQUIRE_CHECK,
    match: {
      minMatchWords: source.ORIGINALITY_MIN_MATCH_WORDS,
      significantRunWords: source.ORIGINALITY_SIGNIFICANT_RUN_WORDS,
      significantCoverage: source.ORIGINALITY_SIGNIFICANT_COVERAGE,
      commonPhraseMinPages: source.ORIGINALITY_COMMON_PHRASE_MIN_PAGES,
      commonPhraseRatio: source.ORIGINALITY_COMMON_PHRASE_RATIO,
      maxGapWords: 3,
    },
    maxCorpusPages: source.ORIGINALITY_MAX_CORPUS_PAGES,
    resultTtlMs: source.ORIGINALITY_RESULT_TTL_MINUTES * 60_000,
  };
}
