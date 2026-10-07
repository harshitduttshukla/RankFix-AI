import { describe, expect, it } from 'vitest';
import { expectedCtr, opportunityConfig } from '../src/services/optimization/opportunity.config.js';
import { detectPageOpportunities, evaluationWindows } from '../src/services/optimization/opportunity-detector.service.js';
import { aggregateMetrics, analyzeQueries, missingTerms, rankQueries, tokenize } from '../src/services/optimization/opportunity-query.service.js';
import { scoreComponents, scoreOpportunity } from '../src/services/optimization/opportunity-scoring.service.js';
import type { PageInput, PeriodMetrics, QueryMetrics } from '../src/services/optimization/opportunity.types.js';
import { PAGE_A, PAGE_B, PAGE_C, PAGE_D } from './opportunity-fixtures.js';

const cfg = opportunityConfig();
const CUR = { start: '2026-09-08', end: '2026-10-05' };
const PREV = { start: '2026-08-11', end: '2026-09-07' };

function period(w: { start: string; end: string }, m: { clicks: number; impressions: number; position: number | null }): PeriodMetrics {
  return { ...w, ...m, ctr: m.impressions ? m.clicks / m.impressions : 0 };
}
const q = (query: string, clicks: number, impressions: number, position: number): QueryMetrics => ({
  query,
  clicks,
  impressions,
  ctr: clicks / impressions,
  position,
});

/** Builds the detector input for a fixture exactly as the repository would (current/previous totals + queries + structure). */
function input(f: typeof PAGE_A): PageInput {
  return {
    pageId: f.path,
    url: `https://site.example.com${f.path}`,
    title: f.structure?.title ?? null,
    current: period(CUR, f.current),
    previous: period(PREV, f.previous),
    queryCount: f.queries.length,
    queries: f.queries.map((x) => q(x.query, x.clicks, x.impressions, x.position)),
    structure: f.structure,
  };
}
const types = (p: PageInput, c = cfg) => detectPageOpportunities(p, c).map((o) => o.type).sort();

describe('GSC aggregation', () => {
  it('sums clicks/impressions and recomputes CTR instead of averaging daily CTRs', () => {
    const m = aggregateMetrics([
      { clicks: 50, impressions: 100, position: 2 },
      { clicks: 9, impressions: 900, position: 10 },
    ]);
    expect(m.clicks).toBe(59);
    expect(m.impressions).toBe(1000);
    expect(m.ctr).toBeCloseTo(0.059, 6); // average of daily CTRs would be 25.5%
  });

  it('weights position by impressions', () => {
    const m = aggregateMetrics([
      { clicks: 50, impressions: 100, position: 2 },
      { clicks: 9, impressions: 900, position: 10 },
    ]);
    expect(m.position).toBe(9.2); // a plain average would be 6
  });

  it('handles zero impressions without dividing by zero', () => {
    expect(aggregateMetrics([])).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: null });
  });

  it('ranks queries by impressions, then clicks, then text (deterministic)', () => {
    const ranked = rankQueries([q('b', 1, 100, 5), q('a', 5, 100, 5), q('c', 0, 500, 9), q('aa', 5, 100, 5)]);
    expect(ranked.map((x) => x.query)).toEqual(['c', 'a', 'aa', 'b']);
  });

  it('computes evaluation windows from the last synced day, capped at the latest final GSC day', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const w = evaluationWindows(new Date('2026-10-07'), cfg, now);
    expect(w.curEnd.toISOString().slice(0, 10)).toBe('2026-10-05'); // 3-day GSC lag
    expect(w.curStart.toISOString().slice(0, 10)).toBe('2026-09-08');
    expect(w.prevEnd.toISOString().slice(0, 10)).toBe('2026-09-07');
    expect(w.prevStart.toISOString().slice(0, 10)).toBe('2026-08-11');
    const older = evaluationWindows(new Date('2026-09-30'), cfg, now);
    expect(older.curEnd.toISOString().slice(0, 10)).toBe('2026-09-30');
  });
});

describe('expected CTR curve', () => {
  it('interpolates between configured points and clamps at the ends', () => {
    expect(expectedCtr(1, cfg)).toBe(0.28);
    expect(expectedCtr(0.5, cfg)).toBe(0.28);
    expect(expectedCtr(7.5, cfg)).toBeCloseTo(0.036, 6);
    expect(expectedCtr(200, cfg)).toBe(0.002);
  });
});

describe('opportunity signals', () => {
  it('page A (30k impressions, 1% CTR, position 7.2) → LOW_CTR, HIGH_IMPRESSIONS_LOW_CLICKS, PAGE_ONE_NEAR_TOP', () => {
    expect(types(input(PAGE_A))).toEqual(['HIGH_IMPRESSIONS_LOW_CLICKS', 'LOW_CTR', 'PAGE_ONE_NEAR_TOP']);
  });

  it('page B (50 impressions, position 40) → nothing', () => {
    expect(types(input(PAGE_B))).toEqual([]);
  });

  it('page C (clicks 2000 → 1000) → PERFORMANCE_DECLINE with click and CTR decline evidence', () => {
    const opps = detectPageOpportunities(input(PAGE_C), cfg);
    const decline = opps.find((o) => o.type === 'PERFORMANCE_DECLINE')!;
    expect(decline).toBeDefined();
    const primary = decline.evidence.filter((e) => e.primary);
    expect(primary.map((e) => e.type)).toEqual(['CLICK_DECLINE', 'CTR_DECLINE']);
    expect(primary[0]).toMatchObject({ metric: 'clicks', value: 1000, previousValue: 2000, threshold: -25 });
    expect(decline.metrics.clickChangePercent).toBe(-50);
  });

  it('page D (high-impression query absent from headings) → CONTENT_COVERAGE_SIGNAL only', () => {
    const opps = detectPageOpportunities(input(PAGE_D), cfg);
    expect(opps.map((o) => o.type)).toEqual(['CONTENT_COVERAGE_SIGNAL']);
    const gap = opps[0]!.evidence.find((e) => e.primary)!;
    expect(gap).toMatchObject({ type: 'CONTENT_COVERAGE_SIGNAL', query: 'kubernetes deployment tutorial' });
    expect(gap.missingTerms).toEqual(['kubernetes', 'deployment', 'tutorial']);
  });

  it('LOW_CTR is position-relative: the same CTR is fine at position 9 but low at position 2', () => {
    const base = input(PAGE_A);
    const at = (position: number, ctr: number): PageInput => ({
      ...base,
      current: period(CUR, { clicks: Math.round(4000 * ctr), impressions: 4000, position }),
    });
    expect(types(at(9, 0.03))).not.toContain('LOW_CTR');
    expect(types(at(2, 0.03))).toContain('LOW_CTR');
  });

  it('HIGH_IMPRESSIONS_LOW_CLICKS fires beyond page one where LOW_CTR does not', () => {
    const p = { ...input(PAGE_A), current: period(CUR, { clicks: 60, impressions: 20_000, position: 24 }) };
    const t = types(p);
    expect(t).toContain('HIGH_IMPRESSIONS_LOW_CLICKS');
    expect(t).not.toContain('LOW_CTR'); // position 24 > lowCtrMaxPosition
    expect(t).not.toContain('PAGE_ONE_NEAR_TOP');
  });

  it('PAGE_ONE_NEAR_TOP requires the configured position band and minimum impressions', () => {
    const at = (position: number, impressions: number): PageInput => ({
      ...input(PAGE_A),
      current: period(CUR, { clicks: Math.round(impressions * 0.05), impressions, position }),
    });
    expect(types(at(4, 1000))).toContain('PAGE_ONE_NEAR_TOP');
    expect(types(at(10, 1000))).toContain('PAGE_ONE_NEAR_TOP');
    expect(types(at(3.9, 1000))).not.toContain('PAGE_ONE_NEAR_TOP');
    expect(types(at(10.1, 1000))).not.toContain('PAGE_ONE_NEAR_TOP');
    expect(types(at(6, 250))).not.toContain('PAGE_ONE_NEAR_TOP'); // below pageOneMinImpressions
  });

  it('does not flag a decline smaller than the threshold or without a previous baseline', () => {
    const small = { ...input(PAGE_C), current: period(CUR, { clicks: 1700, impressions: 40_000, position: 5 }) };
    expect(types(small)).not.toContain('PERFORMANCE_DECLINE');
    const noBaseline = { ...input(PAGE_C), previous: period(PREV, { clicks: 0, impressions: 0, position: null }) };
    expect(types(noBaseline)).not.toContain('PERFORMANCE_DECLINE');
  });

  it('coverage matches query terms against title/H1/headings with light stemming', () => {
    const structure = { title: 'React performance optimization', h1: null, headings: ['Using hooks'] };
    expect(missingTerms('optimizing react performance', structure).missing).toEqual([]);
    expect(missingTerms('react hook guides', structure).missing).toEqual([]); // "guide" is a stopword, "hook"~"hooks"
    expect(missingTerms('react server components', structure).missing).toEqual(['server', 'components']);
    expect(tokenize('How to use React?')).toEqual(['use', 'react']);
  });

  it('does not create a coverage signal when the page has no crawled structure', () => {
    const p = { ...input(PAGE_D), structure: null };
    expect(types(p)).not.toContain('CONTENT_COVERAGE_SIGNAL');
  });

  it('ignores low-impression queries for coverage', () => {
    const qa = analyzeQueries([q('kubernetes', 1, 20, 3)], PAGE_D.structure, cfg);
    expect(qa.coverageGaps).toEqual([]);
  });
});

describe('scoring', () => {
  it('produces a 0–100 score whose breakdown sums to it, weighted per type', () => {
    for (const f of [PAGE_A, PAGE_C, PAGE_D]) {
      for (const o of detectPageOpportunities(input(f), cfg)) {
        expect(o.score).toBeGreaterThanOrEqual(0);
        expect(o.score).toBeLessThanOrEqual(100);
        const sum = o.scoreBreakdown.reduce((s, b) => s + b.points, 0);
        expect(Math.abs(sum - o.score)).toBeLessThan(0.2);
        const weights = o.scoreBreakdown.reduce((s, b) => s + b.weight, 0);
        expect(weights).toBe(100);
        for (const b of o.scoreBreakdown) expect(b.value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('page A scores high; a weaker page with the same signal scores lower', () => {
    const a = detectPageOpportunities(input(PAGE_A), cfg).find((o) => o.type === 'LOW_CTR')!;
    expect(a.score).toBeGreaterThanOrEqual(60);
    const weaker = { ...input(PAGE_A), current: period(CUR, { clicks: 20, impressions: 1200, position: 7.2 }) };
    const w = detectPageOpportunities(weaker, cfg).find((o) => o.type === 'LOW_CTR')!;
    expect(w.score).toBeLessThan(a.score);
  });

  it('is deterministic: same input, same output', () => {
    expect(detectPageOpportunities(input(PAGE_A), cfg)).toEqual(detectPageOpportunities(input(PAGE_A), cfg));
  });

  it('scoreOpportunity uses only the configured weights', () => {
    const comps = { impressions: 1, ctr: 1, position: 1, trend: 1, query: 1, coverage: 1 };
    expect(scoreOpportunity('LOW_CTR', comps, cfg).score).toBe(100);
    const zero = { impressions: 0, ctr: 0, position: 0, trend: 0, query: 0, coverage: 0 };
    expect(scoreOpportunity('PERFORMANCE_DECLINE', zero, cfg).score).toBe(0);
  });

  it('position component peaks at the top of the page-one band', () => {
    const p = input(PAGE_A);
    const qa = analyzeQueries(p.queries, p.structure, cfg);
    const at = (position: number) => scoreComponents({ ...p, current: { ...p.current, position } }, qa, cfg).position;
    expect(at(4)).toBe(1);
    expect(at(10)).toBeCloseTo(0.7, 6);
    expect(at(2)).toBe(0.3);
    expect(at(25)).toBe(0);
  });

  it('opportunities for one page are returned highest score first', () => {
    const scores = detectPageOpportunities(input(PAGE_A), cfg).map((o) => o.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe('evidence', () => {
  it('records actual metrics with thresholds; primary evidence comes first', () => {
    const o = detectPageOpportunities(input(PAGE_A), cfg).find((x) => x.type === 'LOW_CTR')!;
    expect(o.evidence[0]).toMatchObject({ type: 'LOW_CTR', primary: true, metric: 'ctr', unit: 'percent', value: 1, comparison: '<' });
    expect(o.evidence[0]!.threshold).toBeGreaterThan(1);
    const types = o.evidence.map((e) => e.type);
    expect(types).toContain('HIGH_IMPRESSIONS');
    expect(types).toContain('PAGE_ONE_RANKING');
    expect(types).toContain('HIGH_QUERY_IMPRESSIONS');
    expect(o.evidence.filter((e) => e.type === 'LOW_CTR')).toHaveLength(1); // not duplicated as supporting evidence
  });

  it('reports query concentration when one query dominates', () => {
    const o = detectPageOpportunities(input(PAGE_D), cfg)[0]!;
    expect(o.evidence.find((e) => e.type === 'QUERY_CONCENTRATION')).toMatchObject({ query: 'kubernetes deployment tutorial' });
  });

  it('never uses causal or promissory language', () => {
    for (const f of [PAGE_A, PAGE_C, PAGE_D]) {
      for (const o of detectPageOpportunities(input(f), cfg)) {
        const text = [o.metrics.summary, ...o.evidence.map((e) => e.text)].join(' ').toLowerCase();
        expect(text).not.toMatch(/because|will increase|bad content|caused|guarantee/);
      }
    }
    expect(detectPageOpportunities(input(PAGE_A), cfg)[0]!.metrics.summary).toContain(
      'shows a measurable optimization opportunity based on its current Search Console performance',
    );
  });

  it('summarizes the measured performance', () => {
    const o = detectPageOpportunities(input(PAGE_A), cfg)[0]!;
    expect(o.metrics.summary).toContain('30,000 impressions');
    expect(o.metrics.summary).toContain('CTR of 1.0%');
    expect(o.metrics.summary).toContain('average position of 7.2');
  });
});

describe('threshold configuration', () => {
  it('changing a threshold changes detection without code changes', () => {
    expect(types(input(PAGE_A), opportunityConfig({ highImpressions: 50_000 }))).not.toContain('HIGH_IMPRESSIONS_LOW_CLICKS');
    expect(types(input(PAGE_A), opportunityConfig({ pageOneMaxPosition: 6 }))).not.toContain('PAGE_ONE_NEAR_TOP');
    expect(types(input(PAGE_C), opportunityConfig({ minDeclinePercent: 60 }))).not.toContain('PERFORMANCE_DECLINE');
    expect(types(input(PAGE_A), opportunityConfig({ minImpressions: 100_000 }))).toEqual([]);
    expect(types(input(PAGE_D), opportunityConfig({ minQueryImpressions: 5000 }))).not.toContain('CONTENT_COVERAGE_SIGNAL');
  });

  it('every per-type weight row sums to 100', () => {
    for (const row of Object.values(cfg.weights)) expect(Object.values(row).reduce((a, b) => a + b, 0)).toBe(100);
  });
});
