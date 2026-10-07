import { expectedCtr, type OpportunityConfig } from './opportunity.config.js';
import { percentChange } from './opportunity-scoring.service.js';
import type { Evidence, EvidenceType, PageInput, QueryAnalysis } from './opportunity.types.js';

/*
 * Evidence is built only from stored GSC totals and the crawled page structure. Wording describes what was
 * measured and never attributes a cause ("the content is weak") or promises an outcome ("will increase traffic").
 */

const int = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
const pos = (p: number) => p.toFixed(1);
const r2 = (n: number) => Math.round(n * 100) / 100;
/** CTR is stored in evidence as a percentage with two decimals (e.g. 1.23 = 1.23%). */
const asPct = (ratio: number) => Math.round(ratio * 10_000) / 100;

export type EvidenceFacts = Partial<Record<EvidenceType, Evidence[]>>;

/** All measurable facts that hold for this page. Opportunity rules pick their primary evidence from these. */
export function buildEvidenceFacts(page: PageInput, qa: QueryAnalysis, cfg: OpportunityConfig): EvidenceFacts {
  const { current: cur, previous: prev } = page;
  const period = `between ${cur.start} and ${cur.end}`;
  const facts: EvidenceFacts = {};
  const add = (e: Omit<Evidence, 'primary'>) => (facts[e.type] ??= []).push({ ...e, primary: false });

  if (cur.impressions >= cfg.highImpressions) {
    add({
      type: 'HIGH_IMPRESSIONS',
      metric: 'impressions',
      unit: 'count',
      value: cur.impressions,
      threshold: cfg.highImpressions,
      comparison: '>=',
      text: `The page received ${int(cur.impressions)} impressions ${period} (threshold: ${int(cfg.highImpressions)}).`,
    });
  }

  if (cur.position != null && cur.impressions >= cfg.lowCtrMinImpressions && cur.position <= cfg.lowCtrMaxPosition) {
    const expected = expectedCtr(cur.position, cfg);
    const threshold = expected * cfg.lowCtrRatio;
    if (cur.ctr < threshold) {
      add({
        type: 'LOW_CTR',
        metric: 'ctr',
        unit: 'percent',
        value: asPct(cur.ctr),
        threshold: asPct(threshold),
        comparison: '<',
        text:
          `CTR was ${pct(cur.ctr)} at an average position of ${pos(cur.position)}, below the ${pct(threshold)} threshold ` +
          `(${Math.round(cfg.lowCtrRatio * 100)}% of the ≈${pct(expected)} typical for that position).`,
      });
    }
  }

  if (cur.position != null && cur.position >= cfg.pageOneMinPosition && cur.position <= cfg.pageOneMaxPosition) {
    add({
      type: 'PAGE_ONE_RANKING',
      metric: 'position',
      unit: 'position',
      value: r2(cur.position),
      threshold: cfg.pageOneMinPosition,
      thresholdMax: cfg.pageOneMaxPosition,
      comparison: 'between',
      text: `Average position was ${pos(cur.position)}, within the ${cfg.pageOneMinPosition}–${cfg.pageOneMaxPosition} range on page one.`,
    });
  }

  const clickChange = percentChange(prev.clicks, cur.clicks);
  if (prev.clicks >= cfg.declineMinPreviousClicks && clickChange != null && clickChange <= -cfg.minDeclinePercent) {
    add({
      type: 'CLICK_DECLINE',
      metric: 'clicks',
      unit: 'count',
      value: cur.clicks,
      previousValue: prev.clicks,
      threshold: -cfg.minDeclinePercent,
      comparison: '<',
      text:
        `Clicks went from ${int(prev.clicks)} (${prev.start} to ${prev.end}) to ${int(cur.clicks)} (${cur.start} to ${cur.end}), ` +
        `a ${Math.abs(clickChange).toFixed(1)}% decrease (threshold: ${cfg.minDeclinePercent}%).`,
    });
  }

  const ctrChange = percentChange(prev.ctr, cur.ctr);
  if (
    prev.impressions >= cfg.declineMinPreviousImpressions &&
    cur.impressions >= cfg.minImpressions &&
    ctrChange != null &&
    ctrChange <= -cfg.minDeclinePercent
  ) {
    add({
      type: 'CTR_DECLINE',
      metric: 'ctr',
      unit: 'percent',
      value: asPct(cur.ctr),
      previousValue: asPct(prev.ctr),
      threshold: -cfg.minDeclinePercent,
      comparison: '<',
      text: `CTR went from ${pct(prev.ctr)} to ${pct(cur.ctr)} between the two periods, a ${Math.abs(ctrChange).toFixed(1)}% relative decrease.`,
    });
  }

  if (cur.position != null && prev.position != null && prev.impressions > 0 && cur.position - prev.position >= cfg.positionChangeMin) {
    add({
      type: 'POSITION_CHANGE',
      metric: 'position',
      unit: 'position',
      value: r2(cur.position),
      previousValue: r2(prev.position),
      threshold: cfg.positionChangeMin,
      comparison: '>=',
      text: `Average position moved from ${pos(prev.position)} to ${pos(cur.position)} (a higher number is further down the results).`,
    });
  }

  const top = qa.queries[0];
  if (top && top.impressions >= cfg.minQueryImpressions) {
    add({
      type: 'HIGH_QUERY_IMPRESSIONS',
      metric: 'impressions',
      unit: 'count',
      value: top.impressions,
      threshold: cfg.minQueryImpressions,
      comparison: '>=',
      query: top.query,
      text:
        `Top query "${top.query}": ${int(top.impressions)} impressions, ${int(top.clicks)} clicks, CTR ${pct(top.ctr)}` +
        (top.position != null ? `, average position ${pos(top.position)}.` : '.'),
    });
  }

  if (top && qa.totalQueryImpressions > 0 && qa.topQueryShare >= cfg.queryConcentrationShare && page.queryCount > 1) {
    add({
      type: 'QUERY_CONCENTRATION',
      metric: 'top_query_share',
      unit: 'percent',
      value: asPct(qa.topQueryShare),
      threshold: asPct(cfg.queryConcentrationShare),
      comparison: '>=',
      query: top.query,
      text: `"${top.query}" accounts for ${pct(qa.topQueryShare)} of the impressions attributed to individual queries.`,
    });
  }

  for (const gap of qa.coverageGaps) {
    add({
      type: 'CONTENT_COVERAGE_SIGNAL',
      metric: 'covered_term_ratio',
      unit: 'percent',
      value: asPct(gap.coveredRatio),
      threshold: asPct(cfg.coverageMinTermRatio),
      comparison: '<',
      query: gap.query,
      missingTerms: gap.missingTerms,
      text:
        `The query "${gap.query}" had ${int(gap.impressions)} impressions, but the page title, H1 and headings ` +
        `do not contain ${gap.missingTerms.map((t) => `"${t}"`).join(', ')}. The page may not cover this query in a dedicated section.`,
    });
  }

  return facts;
}

/** The HIGH_IMPRESSIONS_LOW_CLICKS rule uses an absolute CTR ceiling (unlike LOW_CTR, which is position-relative). */
export function absoluteLowCtrEvidence(page: PageInput, cfg: OpportunityConfig): Evidence {
  const cur = page.current;
  return {
    type: 'LOW_CTR',
    primary: true,
    metric: 'ctr',
    unit: 'percent',
    value: asPct(cur.ctr),
    threshold: asPct(cfg.highImpressionsMaxCtr),
    comparison: '<',
    text: `Only ${int(cur.clicks)} clicks from ${int(cur.impressions)} impressions: a CTR of ${pct(cur.ctr)}, below ${pct(cfg.highImpressionsMaxCtr)}.`,
  };
}

/** Primary evidence first (in the given order), then supporting facts; nothing duplicated. */
export function assembleEvidence(primary: Evidence[], facts: EvidenceFacts): Evidence[] {
  const seen = new Set(primary.map((e) => `${e.type}:${e.metric}:${e.query ?? ''}`));
  const supporting = Object.values(facts)
    .flat()
    .filter((e) => !seen.has(`${e.type}:${e.metric}:${e.query ?? ''}`));
  return [...primary.map((e) => ({ ...e, primary: true })), ...supporting];
}

/** Neutral one-sentence overview shown above the evidence list. */
export function summarize(page: PageInput): string {
  const c = page.current;
  return (
    `This page received ${int(c.impressions)} impressions and ${int(c.clicks)} clicks between ${c.start} and ${c.end}, ` +
    `with a CTR of ${pct(c.ctr)}` +
    (c.position != null ? ` and an average position of ${pos(c.position)}.` : '.') +
    ' It shows a measurable optimization opportunity based on its current Search Console performance.'
  );
}
