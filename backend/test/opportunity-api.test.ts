import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageStatus } from '@prisma/client';
import { prisma } from '../src/config/database.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { closeGscQueue } from '../src/queues/gsc.queue.js';
import { closeOpportunityQueue } from '../src/queues/opportunity.queue.js';
import { opportunityRepository } from '../src/repositories/opportunity.repository.js';
import { GSC_SCOPE, setGscApiClient } from '../src/services/gsc/gsc-api.client.js';
import { opportunityConfig } from '../src/services/optimization/opportunity.config.js';
import { evaluationWindows, runDetection } from '../src/services/optimization/opportunity-detector.service.js';
import { encryptSecret } from '../src/utils/crypto.js';
import { addDays, latestFinalGscDate } from '../src/utils/dates.js';
import { startGscWorker } from '../src/workers/gsc.worker.js';
import { startOpportunityWorker } from '../src/workers/opportunity.worker.js';
import { FakeGsc, sampleRows } from './fake-gsc.js';
import { client, clientWithProject, resetDb } from './helpers.js';
import { PAGE_A, PAGE_B, PAGE_C, PAGE_D, type PageFixture } from './opportunity-fixtures.js';

beforeEach(async () => {
  await resetDb();
  await redis().flushdb();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await closeOpportunityQueue();
  await closeGscQueue();
  await closeRedis();
  await prisma.$disconnect();
});

const cfg = opportunityConfig();
const API = (projectId: string) => `/api/projects/${projectId}/optimization/opportunities`;

/** Project + website + a GSC property marked as synced through the latest final GSC day (no OAuth round-trip). */
async function seedProject(name = 'alice') {
  const c = await clientWithProject(name);
  const host = `${name}.example.com`;
  const site = (await c.post(`/api/projects/${c.project.id}/websites`, { baseUrl: `https://${host}` }).expect(201)).body as { id: string };
  const scope = { organizationId: c.project.organizationId, projectId: c.project.id };
  const connection = await prisma.gSCConnection.create({
    data: { ...scope, connectedById: c.user.id, googleEmail: `owner@${host}`, refreshTokenEnc: encryptSecret('rt'), scope: GSC_SCOPE },
  });
  const property = await prisma.gSCProperty.create({
    data: {
      ...scope,
      connectionId: connection.id,
      websiteId: site.id,
      siteUrl: `sc-domain:${host}`,
      permissionLevel: 'siteOwner',
      lastSyncedDate: latestFinalGscDate(),
      lastSyncedAt: new Date(),
    },
  });
  return { ...c, scope, site, property, base: `https://${host}` };
}
type Ctx = Awaited<ReturnType<typeof seedProject>>;

/** A crawled page with a current version carrying the fixture's title/H1/headings. */
async function seedPage(ctx: Ctx, f: Pick<PageFixture, 'path' | 'structure'>, status: PageStatus = 'ACTIVE') {
  const page = await prisma.contentPage.create({
    data: { ...ctx.scope, websiteId: ctx.site.id, url: `${ctx.base}${f.path}`, httpStatus: status === 'GONE' ? 404 : 200, status, lastCrawledAt: new Date() },
  });
  const s = f.structure;
  const version = await prisma.contentPageVersion.create({
    data: {
      organizationId: ctx.scope.organizationId,
      pageId: page.id,
      versionNo: 1,
      source: 'CRAWL',
      title: s?.title,
      h1: s?.h1,
      seoMeta: {},
      headings: (s?.headings ?? []).map((text, order) => ({ level: 2, text, order })),
      sections: [],
      bodyHtml: '<p>body</p>',
      bodyText: 'body',
      wordCount: 1,
      contentHash: `hash-${page.id}`,
    },
  });
  await prisma.contentPage.update({ where: { id: page.id }, data: { currentVersionId: version.id, currentVersionNo: 1 } });
  return page;
}

/** Spreads integer totals evenly over each day of a window. */
function spread(total: number, days: number, i: number) {
  return Math.floor(total / days) + (i < total % days ? 1 : 0);
}

/** Writes daily GSC rows so that the window totals equal the fixture's current/previous numbers exactly. */
async function seedGsc(ctx: Ctx, f: Omit<PageFixture, 'structure'>, url = `${ctx.base}${f.path}`) {
  const w = evaluationWindows(ctx.property.lastSyncedDate!, cfg);
  const rows: { date: Date; query: string; clicks: number; impressions: number; position: number }[] = [];
  const days = cfg.windowDays;
  for (let i = 0; i < days; i++) {
    const cur = addDays(w.curStart, i);
    const prev = addDays(w.prevStart, i);
    rows.push({ date: cur, query: '', clicks: spread(f.current.clicks, days, i), impressions: spread(f.current.impressions, days, i), position: f.current.position });
    rows.push({ date: prev, query: '', clicks: spread(f.previous.clicks, days, i), impressions: spread(f.previous.impressions, days, i), position: f.previous.position });
    for (const q of f.queries) {
      rows.push({ date: cur, query: q.query, clicks: spread(q.clicks, days, i), impressions: spread(q.impressions, days, i), position: q.position });
    }
  }
  await prisma.gSCSearchAnalytics.createMany({
    data: rows.map((r) => ({ ...r, ...ctx.scope, propertyId: ctx.property.id, page: url, ctr: r.impressions ? r.clicks / r.impressions : 0 })),
  });
}

async function seedAll(ctx: Ctx) {
  const pages: Record<string, string> = {};
  for (const f of [PAGE_A, PAGE_B, PAGE_C, PAGE_D]) {
    pages[f.path] = (await seedPage(ctx, f)).id;
    await seedGsc(ctx, f);
  }
  return pages;
}

async function detectNow(ctx: Ctx) {
  const run = (await ctx.post(`${API(ctx.project.id)}/detect`).expect(202)).body;
  expect(run.status).toBe('QUEUED');
  return { run, totals: await runDetection(run.id) };
}

const byPage = async (pageId: string) =>
  (await prisma.optimizationOpportunity.findMany({ where: { pageId, status: 'DETECTED' } })).map((o) => o.type).sort();

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('database aggregation', () => {
  it('aggregates page totals with summed clicks/impressions, recomputed CTR and impression-weighted position', async () => {
    const ctx = await seedProject();
    const page = await seedPage(ctx, { path: '/blog/weighted', structure: null });
    const day = ctx.property.lastSyncedDate!;
    const base = { ...ctx.scope, propertyId: ctx.property.id, page: page.url, query: '' };
    await prisma.gSCSearchAnalytics.createMany({
      data: [
        { ...base, date: day, clicks: 50, impressions: 100, ctr: 0.5, position: 2 },
        { ...base, date: addDays(day, -1), clicks: 9, impressions: 900, ctr: 0.01, position: 10 },
        // query rows must not be double counted in page totals
        { ...base, query: 'q1', date: day, clicks: 40, impressions: 80, ctr: 0.5, position: 2 },
        { ...base, query: 'q1', date: addDays(day, -1), clicks: 5, impressions: 300, ctr: 0.02, position: 9 },
        { ...base, query: 'q2', date: day, clicks: 1, impressions: 500, ctr: 0.002, position: 12 },
      ],
    });
    const w = evaluationWindows(day, cfg);
    const [agg] = await opportunityRepository.pageAggregates(ctx.scope, {
      ...w,
      websiteId: ctx.site.id,
      propertyId: ctx.property.id,
      minImpressions: 1,
      offset: 0,
      limit: 10,
    });
    expect(agg!.current).toMatchObject({ clicks: 59, impressions: 1000, position: 9.2 });
    expect(agg!.current.ctr).toBeCloseTo(0.059, 6);
    expect(agg!.previous).toMatchObject({ clicks: 0, impressions: 0, position: null });

    const q = (await opportunityRepository.queriesForPages(ctx.scope, { propertyId: ctx.property.id, pageUrls: [page.url], start: w.curStart, end: w.curEnd, limit: 10 })).get(page.url)!;
    expect(q.queryCount).toBe(2);
    expect(q.queries.map((x) => x.query)).toEqual(['q2', 'q1']); // ranked by impressions
    expect(q.queries[1]).toMatchObject({ clicks: 45, impressions: 380 });
    expect(q.queries[1]!.position).toBeCloseTo((2 * 80 + 9 * 300) / 380, 2);
  });
});

describe('opportunity detection', () => {
  it('detects the expected opportunities for fixture pages A–D from persisted data', async () => {
    const ctx = await seedProject();
    const pages = await seedAll(ctx);
    const { totals } = await detectNow(ctx);
    expect(totals.pagesEvaluated).toBe(3); // B is below the minimum impressions
    expect(await byPage(pages[PAGE_A.path]!)).toEqual(['HIGH_IMPRESSIONS_LOW_CLICKS', 'LOW_CTR', 'PAGE_ONE_NEAR_TOP']);
    expect(await byPage(pages[PAGE_B.path]!)).toEqual([]);
    expect(await byPage(pages[PAGE_C.path]!)).toContain('PERFORMANCE_DECLINE');
    expect(await byPage(pages[PAGE_D.path]!)).toEqual(['CONTENT_COVERAGE_SIGNAL']);

    const lowCtr = await prisma.optimizationOpportunity.findFirstOrThrow({ where: { pageId: pages[PAGE_A.path], type: 'LOW_CTR' } });
    expect(lowCtr).toMatchObject({ websiteId: ctx.site.id, projectId: ctx.project.id, clicks: 300, impressions: 30_000, position: 7.2, pageTitle: 'The Complete React Guide' });
    expect(lowCtr.score).toBeGreaterThan(0);
    expect((lowCtr.evidence as { primary: boolean }[]).some((e) => e.primary)).toBe(true);
    expect((lowCtr.topQueries as { query: string }[])[0]!.query).toBe('react guide');
    expect(await prisma.opportunityDetectionRun.findFirstOrThrow()).toMatchObject({ status: 'COMPLETED', created: totals.created });
    expect(await prisma.auditLog.count({ where: { action: 'opportunity.detection_completed' } })).toBe(1);
  });

  it('only creates opportunities for existing, active, crawled pages of the website', async () => {
    const ctx = await seedProject();
    // GSC data for a URL that was never crawled
    await seedGsc(ctx, { ...PAGE_A, path: '/blog/not-crawled' });
    // crawled but gone
    await seedPage(ctx, { path: '/blog/gone', structure: PAGE_A.structure }, 'GONE');
    await seedGsc(ctx, { ...PAGE_A, path: '/blog/gone' });
    // same path on a different host
    await seedGsc(ctx, PAGE_A, `https://elsewhere.example.net${PAGE_A.path}`);
    await seedPage(ctx, { path: '/blog/other', structure: null });

    const { totals } = await detectNow(ctx);
    expect(totals.pagesEvaluated).toBe(0);
    expect(await prisma.optimizationOpportunity.count()).toBe(0);
  });

  it('rejects an opportunity for a nonexistent page, or a page of another project, at the database level', async () => {
    const alice = await seedProject('alice');
    const bob = await seedProject('bob');
    const bobPage = await seedPage(bob, PAGE_A);
    const row = {
      ...alice.scope,
      websiteId: alice.site.id,
      pageUrl: 'x',
      type: 'LOW_CTR' as const,
      score: 1,
      scoreBreakdown: [],
      dateRangeStart: new Date(),
      dateRangeEnd: new Date(),
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
      metrics: {},
      evidence: [],
      topQueries: [],
    };
    await expect(prisma.optimizationOpportunity.create({ data: { ...row, pageId: 'doesnotexist' } })).rejects.toThrow();
    await expect(prisma.optimizationOpportunity.create({ data: { ...row, pageId: bobPage.id } })).rejects.toThrow();
  });

  it('does not duplicate opportunities when detection runs again; it refreshes them in place', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    await detectNow(ctx);
    const first = await prisma.optimizationOpportunity.findMany({ orderBy: { id: 'asc' } });
    const { totals } = await detectNow(ctx);
    const second = await prisma.optimizationOpportunity.findMany({ orderBy: { id: 'asc' } });
    expect(second.map((o) => o.id)).toEqual(first.map((o) => o.id));
    expect(totals).toMatchObject({ created: 0, updated: first.length, cleared: 0 });
    expect(second.every((o) => o.status === 'DETECTED')).toBe(true);
  });

  it('enforces one open opportunity per (page, type) in the database', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    await detectNow(ctx);
    const o = await prisma.optimizationOpportunity.findFirstOrThrow();
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = o;
    await expect(prisma.optimizationOpportunity.create({ data: { ...copy, scoreBreakdown: [], metrics: {}, evidence: [], topQueries: [], analysis: undefined } })).rejects.toThrow();
  });

  it('clears an open opportunity when its signal no longer holds', async () => {
    const ctx = await seedProject();
    const pages = await seedAll(ctx);
    await detectNow(ctx);
    // Page D's top query disappears: the coverage signal no longer holds.
    await prisma.gSCSearchAnalytics.deleteMany({ where: { query: 'kubernetes deployment tutorial' } });
    const { totals } = await detectNow(ctx);
    expect(totals.cleared).toBe(1);
    const d = await prisma.optimizationOpportunity.findFirstOrThrow({ where: { pageId: pages[PAGE_D.path] } });
    expect(d).toMatchObject({ status: 'DISMISSED', dismissReason: 'SIGNAL_CLEARED', dismissedById: null });
  });

  it('does not re-create an opportunity a user dismissed (snooze)', async () => {
    const ctx = await seedProject();
    const pages = await seedAll(ctx);
    await detectNow(ctx);
    const o = await prisma.optimizationOpportunity.findFirstOrThrow({ where: { pageId: pages[PAGE_A.path], type: 'LOW_CTR' } });
    await ctx.post(`${API(ctx.project.id)}/${o.id}/dismiss`, { reason: 'Seasonal page' }).expect(200);
    await detectNow(ctx);
    expect(await prisma.optimizationOpportunity.count({ where: { pageId: pages[PAGE_A.path], type: 'LOW_CTR' } })).toBe(1);
  });

  it('leaves opportunities already in a later pipeline state untouched', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    await detectNow(ctx);
    const o = await prisma.optimizationOpportunity.findFirstOrThrow();
    await prisma.optimizationOpportunity.update({ where: { id: o.id }, data: { status: 'ANALYZING', score: 1 } });
    await detectNow(ctx);
    expect(await prisma.optimizationOpportunity.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'ANALYZING', score: 1 });
    expect(await prisma.optimizationOpportunity.count({ where: { pageId: o.pageId, type: o.type } })).toBe(1);
  });
});

describe('opportunity API', () => {
  it('lists open opportunities ranked by score, then impressions, then clicks, with reasons', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    await detectNow(ctx);
    const res = (await ctx.get(API(ctx.project.id)).expect(200)).body;
    expect(res.total).toBeGreaterThanOrEqual(5);
    expect(res.latestRun).toMatchObject({ status: 'COMPLETED' });
    const scores = res.items.map((i: { score: number }) => i.score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    for (const item of res.items) {
      expect(item.reasons.length).toBeGreaterThan(0);
      expect(item).toHaveProperty('impressions');
      expect(item).toHaveProperty('ctr');
      expect(item).toHaveProperty('position');
      expect(item).not.toHaveProperty('organizationId');
    }
    const filtered = (await ctx.get(`${API(ctx.project.id)}?type=PERFORMANCE_DECLINE`).expect(200)).body;
    expect(filtered.items.every((i: { type: string }) => i.type === 'PERFORMANCE_DECLINE')).toBe(true);
    await ctx.get(`${API(ctx.project.id)}?type=NOPE`).expect(400);
  });

  it('breaks score ties by impressions, then clicks', async () => {
    const ctx = await seedProject();
    const pages = await Promise.all(['/a', '/b', '/c'].map((path) => seedPage(ctx, { path, structure: null })));
    const base = { ...ctx.scope, websiteId: ctx.site.id, type: 'LOW_CTR' as const, score: 50, scoreBreakdown: [], dateRangeStart: new Date(), dateRangeEnd: new Date(), ctr: 0, position: 5, metrics: {}, evidence: [], topQueries: [] };
    await prisma.optimizationOpportunity.createMany({
      data: [
        { ...base, pageId: pages[0]!.id, pageUrl: '/a', impressions: 100, clicks: 9 },
        { ...base, pageId: pages[1]!.id, pageUrl: '/b', impressions: 900, clicks: 1 },
        { ...base, pageId: pages[2]!.id, pageUrl: '/c', impressions: 100, clicks: 50 },
      ],
    });
    const res = (await ctx.get(API(ctx.project.id)).expect(200)).body;
    expect(res.items.map((i: { pageUrl: string }) => i.pageUrl)).toEqual(['/b', '/c', '/a']);
  });

  it('returns detail with page, metrics, top queries, score breakdown and evidence', async () => {
    const ctx = await seedProject();
    const pages = await seedAll(ctx);
    await detectNow(ctx);
    const o = await prisma.optimizationOpportunity.findFirstOrThrow({ where: { pageId: pages[PAGE_A.path], type: 'LOW_CTR' } });
    const d = (await ctx.get(`${API(ctx.project.id)}/${o.id}`).expect(200)).body;
    expect(d.page).toMatchObject({ id: pages[PAGE_A.path], url: `${ctx.base}${PAGE_A.path}`, title: 'The Complete React Guide' });
    expect(d.page.lastCrawledAt).toBeTruthy();
    expect(d.metrics.current).toMatchObject({ clicks: 300, impressions: 30_000 });
    expect(d.metrics.summary).toContain('30,000 impressions');
    expect(d.topQueries).toHaveLength(3);
    expect(d.scoreBreakdown.length).toBeGreaterThan(0);
    expect(d.evidence[0]).toMatchObject({ type: 'LOW_CTR', primary: true });
    expect(d.dateRangeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('dismisses an open opportunity and audits it; dismissing twice is an invalid transition', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    await detectNow(ctx);
    const o = await prisma.optimizationOpportunity.findFirstOrThrow();
    const res = (await ctx.post(`${API(ctx.project.id)}/${o.id}/dismiss`, { reason: 'Not relevant' }).expect(200)).body;
    expect(res).toMatchObject({ status: 'DISMISSED', dismissReason: 'Not relevant', dismissedById: ctx.user.id });
    expect(await prisma.auditLog.count({ where: { action: 'opportunity.dismissed', entityId: o.id } })).toBe(1);
    await ctx.post(`${API(ctx.project.id)}/${o.id}/dismiss`).expect(409);
    const open = (await ctx.get(API(ctx.project.id)).expect(200)).body;
    expect(open.items.find((i: { id: string }) => i.id === o.id)).toBeUndefined();
    const dismissed = (await ctx.get(`${API(ctx.project.id)}?status=dismissed`).expect(200)).body;
    expect(dismissed.items.map((i: { id: string }) => i.id)).toContain(o.id);
  });

  it('refuses detection before any GSC data is synced', async () => {
    const c = await clientWithProject('carol');
    await c.post(`${API(c.project.id)}/detect`).expect(400);
  });

  it('collapses repeated detection requests into the queued run', async () => {
    const ctx = await seedProject();
    const a = (await ctx.post(`${API(ctx.project.id)}/detect`).expect(202)).body;
    const b = (await ctx.post(`${API(ctx.project.id)}/recalculate`).expect(202)).body;
    expect(b.id).toBe(a.id);
    expect(await prisma.opportunityDetectionRun.count()).toBe(1);
  });
});

describe('tenant isolation and authorization', () => {
  it('hides other tenants’ opportunities and rejects cross-tenant access', async () => {
    const alice = await seedProject('alice');
    await seedAll(alice);
    await detectNow(alice);
    const o = await prisma.optimizationOpportunity.findFirstOrThrow();
    const bob = await seedProject('bob');

    expect((await bob.get(API(bob.project.id)).expect(200)).body.items).toEqual([]);
    // bob's own project URL with alice's opportunity id
    await bob.get(`${API(bob.project.id)}/${o.id}`).expect(404);
    await bob.post(`${API(bob.project.id)}/${o.id}/dismiss`).expect(404);
    // alice's project URL
    await bob.get(API(alice.project.id)).expect(404);
    await bob.get(`${API(alice.project.id)}/${o.id}`).expect(404);
    await bob.post(`${API(alice.project.id)}/detect`).expect(404);
    expect((await prisma.optimizationOpportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('DETECTED');

    // detection for bob never touches alice's data
    await seedAll(bob);
    await detectNow(bob);
    const aliceCount = await prisma.optimizationOpportunity.count({ where: { projectId: alice.project.id } });
    const bobOpps = await prisma.optimizationOpportunity.findMany({ where: { projectId: bob.project.id } });
    expect(bobOpps.length).toBe(aliceCount);
    expect(bobOpps.every((x) => x.organizationId === bob.project.organizationId && x.websiteId === bob.site.id)).toBe(true);
  });

  it('requires authentication', async () => {
    const ctx = await seedProject();
    const anon = await client();
    await anon.get(API(ctx.project.id)).expect(401);
  });

  it('lets viewers read but not detect or dismiss', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    await detectNow(ctx);
    const o = await prisma.optimizationOpportunity.findFirstOrThrow();
    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: ctx.project.organizationId, role: 'VIEWER' } });
    await viewer.get(API(ctx.project.id)).expect(200);
    await viewer.get(`${API(ctx.project.id)}/${o.id}`).expect(200);
    await viewer.post(`${API(ctx.project.id)}/detect`).expect(403);
    await viewer.post(`${API(ctx.project.id)}/${o.id}/dismiss`).expect(403);
  });
});

describe('background detection', () => {
  it('GSC sync → opportunity detection job → opportunities for the crawled page', async () => {
    const fake = new FakeGsc();
    fake.rowsFor = sampleRows;
    setGscApiClient(fake);
    const ctx = await seedProject('alice');
    await prisma.gSCProperty.update({ where: { id: ctx.property.id }, data: { lastSyncedDate: null } });
    const page = await seedPage(ctx, { path: '/blog/post-a', structure: { title: 'SEO guide', h1: 'SEO guide', headings: ['SEO tips'] } });

    const workers = [startGscWorker(), startOpportunityWorker()];
    try {
      await ctx.post(`/api/projects/${ctx.project.id}/gsc/sync`, { days: 60 }).expect(202);
      const run = await waitFor(() =>
        prisma.opportunityDetectionRun.findFirst({ where: { projectId: ctx.project.id, status: { in: ['COMPLETED', 'FAILED'] } } }),
      );
      expect(run).toMatchObject({ status: 'COMPLETED', trigger: 'GSC_SYNC', requestedById: null });
      expect(await byPage(page.id)).toEqual(['HIGH_IMPRESSIONS_LOW_CLICKS', 'LOW_CTR', 'PAGE_ONE_NEAR_TOP']);
      // post-b has GSC data but was never crawled
      expect(await prisma.optimizationOpportunity.count({ where: { pageUrl: { contains: 'post-b' } } })).toBe(0);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
  }, 30_000);

  it('marks a run FAILED with the error when the detection job fails', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    vi.spyOn(opportunityRepository, 'pageAggregates').mockRejectedValue(new Error('database unavailable'));
    const worker = startOpportunityWorker();
    try {
      const run = (await ctx.post(`${API(ctx.project.id)}/detect`).expect(202)).body;
      const done = await waitFor(() => prisma.opportunityDetectionRun.findFirst({ where: { id: run.id, status: 'FAILED' } }));
      expect(done.error).toBe('database unavailable');
      expect(done.completedAt).toBeTruthy();
      expect(await prisma.optimizationOpportunity.count()).toBe(0);
      const list = (await ctx.get(API(ctx.project.id)).expect(200)).body;
      expect(list.latestRun).toMatchObject({ status: 'FAILED', error: 'database unavailable' });
    } finally {
      await worker.close();
    }
  });

  it('a run cannot be processed twice', async () => {
    const ctx = await seedProject();
    await seedAll(ctx);
    const { run } = await detectNow(ctx);
    await expect(runDetection(run.id)).rejects.toThrow(/not queued/);
    expect((await prisma.opportunityDetectionRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('COMPLETED');
  });
});
