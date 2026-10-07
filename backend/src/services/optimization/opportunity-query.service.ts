import type { OpportunityConfig } from './opportunity.config.js';
import type { CoverageGap, PageStructure, QueryAnalysis, QueryMetrics } from './opportunity.types.js';

/** A raw stored GSC row (one day, one page, optionally one query). */
export interface AnalyticsRow {
  clicks: number;
  impressions: number;
  position: number;
}

/**
 * Aggregates GSC rows the way Search Console defines its metrics:
 * clicks and impressions are summed; CTR is recomputed as clicks / impressions (never an average of daily CTRs);
 * position is impression-weighted (an average of daily positions would over-weight low-traffic days).
 * Mirrors the SQL in opportunity.repository.ts, which does the same in the database.
 */
export function aggregateMetrics(rows: AnalyticsRow[]): { clicks: number; impressions: number; ctr: number; position: number | null } {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    weighted += r.position * r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: ctrOf(clicks, impressions),
    position: impressions > 0 ? round2(weighted / impressions) : null,
  };
}

export const ctrOf = (clicks: number, impressions: number) => (impressions > 0 ? clicks / impressions : 0);
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Deterministic order: impressions, then clicks, then the query text as a tiebreaker. */
export function rankQueries(queries: QueryMetrics[]): QueryMetrics[] {
  return [...queries].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query));
}

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it its me my of on or the that this to vs was what when where which who why will with without you your best top guide 2023 2024 2025 2026'.split(' '),
);

/** Lowercase, accent-free word tokens of length >= 2, minus stopwords. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !STOPWORDS.has(stem(t)));
}

/** Light suffix stripping so "guides"/"guide" and "optimizing"/"optimize" compare equal. */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  if (/ations?$/.test(token)) return token.replace(/ations?$/, '');
  if (/ings?$/.test(token)) return token.replace(/ings?$/, '');
  if (/ies$/.test(token)) return token.replace(/ies$/, 'y');
  if (/(ch|sh|x|z|ss)es$/.test(token)) return token.slice(0, -2);
  if (/ed$/.test(token)) return token.slice(0, -2);
  if (/[^s]s$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Two terms match if their stems are equal, or both are long and share a 5-character prefix ("optimization" ~ "optimize"). */
function termsMatch(a: string, b: string): boolean {
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return true;
  return sa.length >= 5 && sb.length >= 5 && sa.slice(0, 5) === sb.slice(0, 5);
}

/** Which query terms appear nowhere in the page's title, H1 or headings. */
export function missingTerms(query: string, structure: PageStructure): { terms: string[]; missing: string[] } {
  const terms = [...new Set(tokenize(query))];
  const structural = new Set(tokenize([structure.title ?? '', structure.h1 ?? '', ...structure.headings].join(' ')));
  const missing = terms.filter((term) => ![...structural].some((s) => termsMatch(term, s)));
  return { terms, missing };
}

/**
 * Query-level analysis for one page. Only queries already in GSC are considered; nothing here
 * proposes new keywords. Coverage is a structural heuristic, not a judgement of content quality.
 */
export function analyzeQueries(queries: QueryMetrics[], structure: PageStructure | null, cfg: OpportunityConfig): QueryAnalysis {
  const ranked = rankQueries(queries);
  const total = ranked.reduce((s, q) => s + q.impressions, 0);
  const improvable = ranked
    .filter((q) => q.position != null && q.position >= cfg.pageOneMinPosition && q.position <= cfg.lowCtrMaxPosition)
    .reduce((s, q) => s + q.impressions, 0);

  const coverageGaps: CoverageGap[] = [];
  if (structure) {
    for (const q of ranked.filter((x) => x.impressions >= cfg.minQueryImpressions).slice(0, cfg.coverageMaxQueries)) {
      const { terms, missing } = missingTerms(q.query, structure);
      if (!terms.length) continue;
      const coveredRatio = (terms.length - missing.length) / terms.length;
      if (coveredRatio < cfg.coverageMinTermRatio) {
        coverageGaps.push({
          query: q.query,
          impressions: q.impressions,
          clicks: q.clicks,
          position: q.position,
          terms,
          missingTerms: missing,
          coveredRatio: round2(coveredRatio),
        });
      }
    }
  }
  const uncovered = coverageGaps.reduce((s, g) => s + g.impressions, 0);

  return {
    queries: ranked,
    totalQueryImpressions: total,
    improvableShare: total > 0 ? improvable / total : 0,
    topQueryShare: total > 0 ? (ranked[0]?.impressions ?? 0) / total : 0,
    coverageGaps,
    uncoveredShare: total > 0 ? uncovered / total : 0,
  };
}
