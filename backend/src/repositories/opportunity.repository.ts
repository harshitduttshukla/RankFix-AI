import { Prisma, type DetectionStatus, type DetectionTrigger, type OpportunityStatus, type OpportunityType } from '@prisma/client';
import { prisma } from '../config/database.js';
import type { DetectedOpportunity, PageInput, QueryMetrics } from '../services/optimization/opportunity.types.js';
import type { TenantContext } from '../types/tenant.js';
import { toIsoDate } from './gsc.repository.js';
import type { Db } from './types.js';

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;
const t = (scope: Scope) => ({ organizationId: scope.organizationId, projectId: scope.projectId });
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Opportunities the detector may refresh in place. */
export const REFRESHABLE: OpportunityStatus[] = ['DETECTED', 'REVIEWED'];
/** Terminal states: a new opportunity may be created for the same (page, type). Mirrors the partial unique index. */
export const TERMINAL: OpportunityStatus[] = ['COMPLETED', 'REJECTED', 'FAILED', 'DISMISSED'];

export interface Windows {
  curStart: Date;
  curEnd: Date;
  prevStart: Date;
  prevEnd: Date;
}

interface PageAggRow {
  pageId: string;
  url: string;
  title: string | null;
  h1: string | null;
  headings: { text: string }[] | null;
  c_clicks: bigint | null;
  c_impr: bigint | null;
  c_pos: number | null;
  p_clicks: bigint | null;
  p_impr: bigint | null;
  p_pos: number | null;
}

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);
const round2 = (v: number | null) => (v == null ? null : Math.round(Number(v) * 100) / 100);

function period(start: Date, end: Date, clicks: number, impressions: number, position: number | null) {
  return { start: toIsoDate(start), end: toIsoDate(end), clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: round2(position) };
}

export const opportunityRepository = {
  /**
   * Page-level totals for the current and previous windows in a single scan of the page-total rows (query = ''),
   * joined to ACTIVE crawled pages of this website. GSC pages without a matching ContentPage are excluded here,
   * so an opportunity can only ever be built for an existing page.
   * Aggregation follows GSC semantics: sums for clicks/impressions, impression-weighted position, CTR recomputed.
   */
  async pageAggregates(
    scope: Scope,
    f: { websiteId: string; propertyId: string; minImpressions: number; offset: number; limit: number } & Windows,
  ): Promise<Omit<PageInput, 'queries' | 'queryCount'>[]> {
    const rows = await prisma.$queryRaw<PageAggRow[]>`
      WITH agg AS (
        SELECT page,
          SUM(clicks)      FILTER (WHERE date >= ${f.curStart}::date) AS c_clicks,
          SUM(impressions) FILTER (WHERE date >= ${f.curStart}::date) AS c_impr,
          SUM(position * impressions) FILTER (WHERE date >= ${f.curStart}::date)
            / NULLIF(SUM(impressions) FILTER (WHERE date >= ${f.curStart}::date), 0) AS c_pos,
          SUM(clicks)      FILTER (WHERE date <= ${f.prevEnd}::date) AS p_clicks,
          SUM(impressions) FILTER (WHERE date <= ${f.prevEnd}::date) AS p_impr,
          SUM(position * impressions) FILTER (WHERE date <= ${f.prevEnd}::date)
            / NULLIF(SUM(impressions) FILTER (WHERE date <= ${f.prevEnd}::date), 0) AS p_pos
        FROM "GSCSearchAnalytics"
        WHERE "organizationId" = ${scope.organizationId} AND "projectId" = ${scope.projectId}
          AND "propertyId" = ${f.propertyId} AND query = ''
          AND date BETWEEN ${f.prevStart}::date AND ${f.curEnd}::date
        GROUP BY page
        HAVING COALESCE(SUM(impressions) FILTER (WHERE date >= ${f.curStart}::date), 0) >= ${f.minImpressions}
            OR COALESCE(SUM(impressions) FILTER (WHERE date <= ${f.prevEnd}::date), 0) >= ${f.minImpressions}
      )
      SELECT p.id AS "pageId", p.url, v.title, v.h1, v.headings,
             agg.c_clicks, agg.c_impr, agg.c_pos, agg.p_clicks, agg.p_impr, agg.p_pos
      FROM agg
      JOIN "ContentPage" p
        ON p.url = agg.page AND p."websiteId" = ${f.websiteId}
       AND p."organizationId" = ${scope.organizationId} AND p."projectId" = ${scope.projectId}
       AND p.status = 'ACTIVE'
      LEFT JOIN "ContentPageVersion" v ON v.id = p."currentVersionId"
      ORDER BY COALESCE(agg.c_impr, 0) DESC, p.id
      LIMIT ${f.limit} OFFSET ${f.offset}`;

    return rows.map((r) => ({
      pageId: r.pageId,
      url: r.url,
      title: r.title,
      current: period(f.curStart, f.curEnd, num(r.c_clicks), num(r.c_impr), r.c_pos),
      previous: period(f.prevStart, f.prevEnd, num(r.p_clicks), num(r.p_impr), r.p_pos),
      structure:
        r.title != null || r.h1 != null || r.headings
          ? { title: r.title, h1: r.h1, headings: (r.headings ?? []).map((h) => h.text).filter(Boolean) }
          : null,
    }));
  },

  /** Top queries (impressions desc, clicks desc, query) and distinct query count for a batch of page URLs. */
  async queriesForPages(
    scope: Scope,
    f: { propertyId: string; pageUrls: string[]; start: Date; end: Date; limit: number },
  ): Promise<Map<string, { queryCount: number; queries: QueryMetrics[] }>> {
    const out = new Map<string, { queryCount: number; queries: QueryMetrics[] }>();
    if (!f.pageUrls.length) return out;
    const rows = await prisma.$queryRaw<
      { page: string; query: string; clicks: bigint; impressions: bigint; wpos: number | null; query_count: bigint }[]
    >`
      SELECT page, query, clicks, impressions, wpos, query_count FROM (
        SELECT page, query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
               SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS wpos,
               COUNT(*) OVER (PARTITION BY page) AS query_count,
               ROW_NUMBER() OVER (PARTITION BY page ORDER BY SUM(impressions) DESC, SUM(clicks) DESC, query) AS rn
        FROM "GSCSearchAnalytics"
        WHERE "organizationId" = ${scope.organizationId} AND "projectId" = ${scope.projectId}
          AND "propertyId" = ${f.propertyId} AND query <> ''
          AND page = ANY(${f.pageUrls}::text[])
          AND date BETWEEN ${f.start}::date AND ${f.end}::date
        GROUP BY page, query
      ) ranked
      WHERE rn <= ${f.limit}
      ORDER BY page, rn`;
    for (const r of rows) {
      const entry = out.get(r.page) ?? { queryCount: num(r.query_count), queries: [] };
      const clicks = num(r.clicks);
      const impressions = num(r.impressions);
      entry.queries.push({ query: r.query, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: round2(r.wpos) });
      out.set(r.page, entry);
    }
    return out;
  },

  /**
   * Creates or refreshes the single non-terminal opportunity for (page, type).
   * - existing DETECTED/REVIEWED → updated in place (same id, new window/metrics/score)
   * - existing in a later pipeline state (ANALYZING, PROPOSED, …) → left untouched
   * - recently dismissed by a user → suppressed until the snooze expires
   * The partial unique index makes a concurrent duplicate insert fail; that case is retried as an update.
   */
  async upsertDetected(
    website: { id: string; organizationId: string; projectId: string },
    page: { pageId: string; url: string; title: string | null },
    o: DetectedOpportunity,
    ctx: { runId: string; windowStart: Date; windowEnd: Date; snoozeSince: Date; now: Date },
    attempt = 0,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const fields = {
      pageUrl: page.url,
      pageTitle: page.title,
      score: o.score,
      scoreBreakdown: json(o.scoreBreakdown),
      dateRangeStart: ctx.windowStart,
      dateRangeEnd: ctx.windowEnd,
      clicks: o.metrics.current.clicks,
      impressions: o.metrics.current.impressions,
      ctr: o.metrics.current.ctr,
      position: o.metrics.current.position ?? 0,
      metrics: json(o.metrics),
      evidence: json(o.evidence),
      topQueries: json(o.topQueries),
      lastDetectedAt: ctx.now,
      detectionRunId: ctx.runId,
    };
    const where = { organizationId: website.organizationId, projectId: website.projectId, websiteId: website.id, pageId: page.pageId, type: o.type };

    const open = await prisma.optimizationOpportunity.findFirst({ where: { ...where, status: { notIn: TERMINAL } }, select: { id: true, status: true } });
    if (open) {
      if (!REFRESHABLE.includes(open.status)) return 'skipped';
      const { count } = await prisma.optimizationOpportunity.updateMany({ where: { id: open.id, status: { in: REFRESHABLE } }, data: fields });
      return count ? 'updated' : 'skipped';
    }

    const snoozed = await prisma.optimizationOpportunity.findFirst({
      where: { ...where, status: 'DISMISSED', dismissedById: { not: null }, dismissedAt: { gte: ctx.snoozeSince } },
      select: { id: true },
    });
    if (snoozed) return 'skipped';

    try {
      await prisma.optimizationOpportunity.create({ data: { ...where, ...fields, type: o.type, status: 'DETECTED' } });
      return 'created';
    } catch (err) {
      if (attempt === 0 && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return opportunityRepository.upsertDetected(website, page, o, ctx, 1);
      }
      throw err;
    }
  },

  /** Open opportunities on this website that the given run did not re-detect: the signal no longer holds. */
  async clearStale(scope: Scope, websiteId: string, runId: string, now: Date) {
    const { count } = await prisma.optimizationOpportunity.updateMany({
      where: { ...t(scope), websiteId, status: 'DETECTED', OR: [{ detectionRunId: null }, { detectionRunId: { not: runId } }] },
      data: { status: 'DISMISSED', dismissReason: 'SIGNAL_CLEARED', dismissedAt: now },
    });
    return count;
  },

  list(
    scope: Scope,
    f: { statuses?: OpportunityStatus[]; type?: OpportunityType; websiteId?: string; limit: number; offset: number },
  ) {
    const where: Prisma.OptimizationOpportunityWhereInput = {
      ...t(scope),
      ...(f.statuses ? { status: { in: f.statuses } } : {}),
      ...(f.type ? { type: f.type } : {}),
      ...(f.websiteId ? { websiteId: f.websiteId } : {}),
    };
    return Promise.all([
      prisma.optimizationOpportunity.findMany({
        where,
        orderBy: [{ score: 'desc' }, { impressions: 'desc' }, { clicks: 'desc' }, { id: 'asc' }],
        take: f.limit,
        skip: f.offset,
        select: {
          id: true,
          websiteId: true,
          pageId: true,
          pageUrl: true,
          pageTitle: true,
          type: true,
          score: true,
          status: true,
          clicks: true,
          impressions: true,
          ctr: true,
          position: true,
          dateRangeStart: true,
          dateRangeEnd: true,
          evidence: true,
          lastDetectedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.optimizationOpportunity.count({ where }),
    ]);
  },

  find(scope: Scope, id: string, db: Db = prisma) {
    return db.optimizationOpportunity.findFirst({
      where: { id, ...t(scope) },
      include: {
        page: {
          select: {
            id: true,
            url: true,
            status: true,
            lastCrawledAt: true,
            websiteId: true,
            currentVersion: { select: { title: true, metaDescription: true, h1: true, wordCount: true, versionNo: true } },
          },
        },
      },
    });
  },

  /** Conditional transition so a concurrent change can't be overwritten. */
  dismiss(scope: Scope, id: string, data: { userId: string; reason: string | null }, db: Db = prisma) {
    return db.optimizationOpportunity.updateMany({
      where: { id, ...t(scope), status: { in: REFRESHABLE } },
      data: { status: 'DISMISSED', dismissedById: data.userId, dismissReason: data.reason ?? 'USER_DISMISSED', dismissedAt: new Date() },
    });
  },

  // ── Detection runs ──

  createRun(scope: Scope, data: { trigger: DetectionTrigger; requestedById: string | null; config: unknown }) {
    return prisma.opportunityDetectionRun.create({ data: { ...t(scope), trigger: data.trigger, requestedById: data.requestedById, config: json(data.config) } });
  },

  findQueuedRun(scope: Scope) {
    return prisma.opportunityDetectionRun.findFirst({ where: { ...t(scope), status: 'QUEUED' }, orderBy: { createdAt: 'desc' } });
  },

  latestRun(scope: Scope) {
    return prisma.opportunityDetectionRun.findFirst({ where: t(scope), orderBy: { createdAt: 'desc' } });
  },

  findRun(runId: string) {
    return prisma.opportunityDetectionRun.findUnique({ where: { id: runId } });
  },

  transitionRun(runId: string, from: DetectionStatus[], data: Prisma.OpportunityDetectionRunUpdateManyMutationInput) {
    return prisma.opportunityDetectionRun.updateMany({ where: { id: runId, status: { in: from } }, data });
  },

  failStaleRuns(cutoff: Date) {
    return prisma.opportunityDetectionRun.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: cutoff } },
      data: { status: 'FAILED', error: 'Detection was interrupted', completedAt: new Date() },
    });
  },
};
