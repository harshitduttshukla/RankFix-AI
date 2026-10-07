import type { OpportunityType } from '@prisma/client';
import { auditRepository } from '../../repositories/audit.repository.js';
import { gscRepository } from '../../repositories/gsc.repository.js';
import { opportunityRepository, type Windows } from '../../repositories/opportunity.repository.js';
import { addDays, isoDate, latestFinalGscDate, utcDay } from '../../utils/dates.js';
import { logger } from '../../utils/logger.js';
import { expectedCtr, opportunityConfig, type OpportunityConfig } from './opportunity.config.js';
import { absoluteLowCtrEvidence, assembleEvidence, buildEvidenceFacts, summarize, type EvidenceFacts } from './opportunity-evidence.service.js';
import { analyzeQueries } from './opportunity-query.service.js';
import { percentChange, scoreComponents, scoreOpportunity } from './opportunity-scoring.service.js';
import type { DetectedOpportunity, Evidence, OpportunityMetrics, PageInput } from './opportunity.types.js';

/*
 * Deterministic detection: GSC totals + crawled structure → rules → score → evidence.
 * No AI and no randomness; the same stored data and config always produce the same opportunities.
 */

interface Rule {
  type: OpportunityType;
  /** Primary evidence when the rule fires, or null when it doesn't. */
  match(page: PageInput, facts: EvidenceFacts, cfg: OpportunityConfig): Evidence[] | null;
}

export const RULES: Rule[] = [
  {
    type: 'LOW_CTR',
    match: (_p, facts) => facts.LOW_CTR ?? null,
  },
  {
    type: 'PAGE_ONE_NEAR_TOP',
    match: (p, facts, cfg) => (facts.PAGE_ONE_RANKING && p.current.impressions >= cfg.pageOneMinImpressions ? facts.PAGE_ONE_RANKING : null),
  },
  {
    type: 'HIGH_IMPRESSIONS_LOW_CLICKS',
    match: (p, facts, cfg) =>
      facts.HIGH_IMPRESSIONS && p.current.ctr < cfg.highImpressionsMaxCtr ? [...facts.HIGH_IMPRESSIONS, absoluteLowCtrEvidence(p, cfg)] : null,
  },
  {
    type: 'PERFORMANCE_DECLINE',
    match: (_p, facts) => {
      const e = [...(facts.CLICK_DECLINE ?? []), ...(facts.CTR_DECLINE ?? [])];
      return e.length ? e : null;
    },
  },
  {
    type: 'CONTENT_COVERAGE_SIGNAL',
    match: (_p, facts) => facts.CONTENT_COVERAGE_SIGNAL ?? null,
  },
];

/** Pure: every opportunity this page shows, highest score first. */
export function detectPageOpportunities(page: PageInput, cfg: OpportunityConfig): DetectedOpportunity[] {
  if (page.current.impressions < cfg.minImpressions && page.previous.impressions < cfg.minImpressions) return [];

  const qa = analyzeQueries(page.queries, page.structure, cfg);
  const facts = buildEvidenceFacts(page, qa, cfg);
  const components = scoreComponents(page, qa, cfg);
  const metrics: OpportunityMetrics = {
    current: page.current,
    previous: page.previous,
    expectedCtr: page.current.position == null ? null : expectedCtr(page.current.position, cfg),
    queryCount: page.queryCount,
    clickChangePercent: round1(percentChange(page.previous.clicks, page.current.clicks)),
    ctrChangePercent: round1(percentChange(page.previous.ctr, page.current.ctr)),
    positionChange:
      page.current.position != null && page.previous.position != null && page.previous.impressions > 0
        ? Math.round((page.current.position - page.previous.position) * 100) / 100
        : null,
    coverageGaps: qa.coverageGaps,
    summary: summarize(page),
  };
  const topQueries = qa.queries.slice(0, cfg.topQueriesLimit);

  const out: DetectedOpportunity[] = [];
  for (const rule of RULES) {
    const primary = rule.match(page, facts, cfg);
    if (!primary) continue;
    const { score, breakdown } = scoreOpportunity(rule.type, components, cfg);
    out.push({ type: rule.type, score, scoreBreakdown: breakdown, evidence: assembleEvidence(primary, facts), metrics, topQueries });
  }
  return out.sort((a, b) => b.score - a.score);
}

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** Current window ends at the latest final GSC day we actually have; previous window is the same length before it. */
export function evaluationWindows(lastSyncedDate: Date, cfg: Pick<OpportunityConfig, 'windowDays'>, now = new Date()): Windows {
  const final = latestFinalGscDate(now);
  const curEnd = utcDay(lastSyncedDate) < final ? utcDay(lastSyncedDate) : final;
  const curStart = addDays(curEnd, -(cfg.windowDays - 1));
  const prevEnd = addDays(curStart, -1);
  return { curStart, curEnd, prevEnd, prevStart: addDays(prevEnd, -(cfg.windowDays - 1)) };
}

export class DetectionAbortedError extends Error {}

/**
 * Runs one OpportunityDetectionRun: every website with synced GSC data in the project, pages in DB batches.
 * Only ACTIVE crawled pages are evaluated (enforced by the SQL join and by the composite FK on insert).
 */
export async function runDetection(runId: string, cfg: OpportunityConfig = opportunityConfig(), now = new Date()) {
  const run = await opportunityRepository.findRun(runId);
  if (!run) throw new DetectionAbortedError('Detection run no longer exists');
  const started = await opportunityRepository.transitionRun(runId, ['QUEUED'], { status: 'RUNNING', startedAt: now, error: null });
  if (!started.count) throw new DetectionAbortedError(`Detection run is not queued (${run.status})`);

  const scope = { organizationId: run.organizationId, projectId: run.projectId };
  const totals = { websitesEvaluated: 0, pagesEvaluated: 0, created: 0, updated: 0, cleared: 0 };
  const windows: { websiteId: string; start: string; end: string }[] = [];

  try {
    const properties = (await gscRepository.listProperties(scope)).filter((p) => p.lastSyncedDate);
    for (const property of properties) {
      const w = evaluationWindows(property.lastSyncedDate!, cfg, now);
      const website = { id: property.websiteId, ...scope };
      const ctx = { runId, windowStart: w.curStart, windowEnd: w.curEnd, snoozeSince: addDays(now, -cfg.dismissSnoozeDays), now };

      for (let offset = 0; ; offset += cfg.batchSize) {
        const pages = await opportunityRepository.pageAggregates(scope, {
          ...w,
          websiteId: property.websiteId,
          propertyId: property.id,
          minImpressions: cfg.minImpressions,
          offset,
          limit: cfg.batchSize,
        });
        if (!pages.length) break;
        const queries = await opportunityRepository.queriesForPages(scope, {
          propertyId: property.id,
          pageUrls: pages.map((p) => p.url),
          start: w.curStart,
          end: w.curEnd,
          limit: cfg.topQueriesLimit,
        });
        for (const p of pages) {
          const q = queries.get(p.url);
          const input: PageInput = { ...p, queryCount: q?.queryCount ?? 0, queries: q?.queries ?? [] };
          for (const o of detectPageOpportunities(input, cfg)) {
            const result = await opportunityRepository.upsertDetected(website, p, o, ctx);
            if (result === 'created') totals.created++;
            else if (result === 'updated') totals.updated++;
          }
        }
        totals.pagesEvaluated += pages.length;
        if (pages.length < cfg.batchSize) break;
      }
      totals.cleared += await opportunityRepository.clearStale(scope, property.websiteId, runId, now);
      totals.websitesEvaluated++;
      windows.push({ websiteId: property.websiteId, start: isoDate(w.curStart), end: isoDate(w.curEnd) });
    }
  } catch (err) {
    await markDetectionFailed(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  await opportunityRepository.transitionRun(runId, ['RUNNING'], { status: 'COMPLETED', completedAt: new Date(), ...totals });
  await auditRepository.record({
    ...scope,
    actorUserId: run.requestedById,
    action: 'opportunity.detection_completed',
    entityType: 'OpportunityDetectionRun',
    entityId: runId,
    metadata: { ...totals, trigger: run.trigger, windows },
  });
  logger.info({ runId, ...totals }, 'Opportunity detection completed');
  return totals;
}

export async function markDetectionFailed(runId: string, message: string) {
  await opportunityRepository.transitionRun(runId, ['QUEUED', 'RUNNING'], { status: 'FAILED', error: message.slice(0, 500), completedAt: new Date() });
}
