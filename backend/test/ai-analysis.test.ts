import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { prisma } from '../src/config/database.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { closeAIAnalysisQueue } from '../src/queues/ai-analysis.queue.js';
import { AIError } from '../src/services/ai/ai.errors.js';
import { setAIProvider } from '../src/services/ai/ai.provider.js';
import { buildAIContext, CONTEXT_LIMITS } from '../src/services/ai/ai-context.builder.js';
import { runAIAnalysis } from '../src/services/ai/opportunity-analysis.service.js';
import { startAIAnalysisWorker } from '../src/workers/ai-analysis.worker.js';
import { FakeAI, validAnalysis } from './ai-fixtures.js';
import { client, clientWithProject, resetDb } from './helpers.js';

let fake: FakeAI;
beforeEach(async () => {
  await resetDb();
  await redis().flushdb();
  fake = new FakeAI();
  setAIProvider(fake);
});
afterEach(() => setAIProvider(null));
afterAll(async () => {
  await closeAIAnalysisQueue();
  await closeRedis();
  await prisma.$disconnect();
});

const API = (projectId: string) => `/api/projects/${projectId}/optimization/opportunities`;

/** Project → website → crawled page (2 sections, 1 internal link) → DETECTED opportunity. */
async function seed(name = 'alice', opts: { sectionText?: string; withVersion?: boolean } = {}) {
  const c = await clientWithProject(name);
  const host = `${name}.example.com`;
  const site = (await c.post(`/api/projects/${c.project.id}/websites`, { baseUrl: `https://${host}` }).expect(201)).body as { id: string };
  const scope = { organizationId: c.project.organizationId, projectId: c.project.id };
  const page = await prisma.contentPage.create({
    data: { ...scope, websiteId: site.id, url: `https://${host}/blog/react-guide`, httpStatus: 200, lastCrawledAt: new Date() },
  });
  if (opts.withVersion !== false) {
    const v = await prisma.contentPageVersion.create({
      data: {
        organizationId: scope.organizationId,
        pageId: page.id,
        versionNo: 1,
        source: 'CRAWL',
        title: 'React Guide',
        metaDescription: 'Learn React.',
        h1: 'React Guide',
        seoMeta: {},
        headings: [{ level: 2, text: 'React hooks tutorial', order: 0 }, { level: 2, text: 'State management', order: 1 }],
        sections: [],
        bodyHtml: '<p>x</p>',
        bodyText: 'x',
        wordCount: 900,
        contentHash: `h-${page.id}`,
        pageSections: {
          create: [
            { organizationId: scope.organizationId, sectionKey: 's1-react-hooks-tutorial', order: 0, heading: 'React hooks tutorial', level: 2, html: '', text: opts.sectionText ?? 'Hooks let you use state.', wordCount: 400, blocks: [] },
            { organizationId: scope.organizationId, sectionKey: 's2-state-management', order: 1, heading: 'State management', level: 2, html: '', text: 'Context and reducers.', wordCount: 500, blocks: [] },
          ],
        },
        links: { create: [{ organizationId: scope.organizationId, targetUrl: `https://${host}/blog/hooks`, anchorText: 'hooks deep dive', isInternal: true, inContent: true, rel: [] }] },
      },
    });
    await prisma.contentPage.update({ where: { id: page.id }, data: { currentVersionId: v.id, currentVersionNo: 1 } });
  }
  const period = (start: string, end: string, clicks: number, impressions: number, position: number) => ({ start, end, clicks, impressions, ctr: clicks / impressions, position });
  const opp = await prisma.optimizationOpportunity.create({
    data: {
      ...scope,
      websiteId: site.id,
      pageId: page.id,
      pageUrl: page.url,
      pageTitle: 'React Guide',
      type: 'LOW_CTR',
      score: 72,
      scoreBreakdown: [{ component: 'ctr', value: 0.7, weight: 35, points: 24.5 }],
      dateRangeStart: new Date('2026-09-01'),
      dateRangeEnd: new Date('2026-09-28'),
      clicks: 300,
      impressions: 30000,
      ctr: 0.01,
      position: 7.2,
      metrics: {
        current: period('2026-09-01', '2026-09-28', 300, 30000, 7.2),
        previous: period('2026-08-04', '2026-08-31', 310, 29000, 7),
        expectedCtr: 0.038,
        queryCount: 3,
        clickChangePercent: -3.2,
        ctrChangePercent: -6.5,
        positionChange: 0.2,
        coverageGaps: [],
        summary: 's',
      },
      evidence: [{ type: 'LOW_CTR', primary: true, metric: 'ctr', unit: 'percent', value: 1, threshold: 2.3, comparison: '<', text: 'CTR was 1.0%' }],
      topQueries: [
        { query: 'react guide', clicks: 120, impressions: 12000, ctr: 0.01, position: 6.5 },
        { query: 'react hooks tutorial', clicks: 80, impressions: 8000, ctr: 0.01, position: 7.4 },
        { query: 'react performance', clicks: 10, impressions: 3000, ctr: 0.0033, position: 9.1 },
      ],
    },
  });
  return { ...c, scope, site, page, opp };
}
type Ctx = Awaited<ReturnType<typeof seed>>;

async function analyze(ctx: Ctx) {
  const run = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(202)).body;
  return run as { id: string; status: string };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('AI context builder', () => {
  it('includes the opportunity, metrics, queries and page structure from stored data', async () => {
    const ctx = await seed();
    const c = await buildAIContext(ctx.scope, ctx.opp.id);
    expect(c.contextVersion).toBe('opportunity-context-v1');
    expect(c.opportunity).toMatchObject({ id: ctx.opp.id, type: 'LOW_CTR', score: 72, dateRange: { start: '2026-09-01', end: '2026-09-28' } });
    expect(c.opportunity.metrics.current).toMatchObject({ clicks: 300, impressions: 30000 });
    expect(c.opportunity.topQueries.map((q) => q.query)).toEqual(['react guide', 'react hooks tutorial', 'react performance']);
    expect(c.opportunity.evidence[0]).toMatchObject({ type: 'LOW_CTR', text: 'CTR was 1.0%' });
    expect(c.page.content).toMatchObject({ title: 'React Guide', metaDescription: 'Learn React.', h1: 'React Guide', wordCount: 900, contentTruncated: false });
    expect(c.page.content!.sections.map((s) => s.sectionKey)).toEqual(['s1-react-hooks-tutorial', 's2-state-management']);
    expect(c.page.content!.internalLinks).toEqual([{ targetUrl: 'https://alice.example.com/blog/hooks', anchorText: 'hooks deep dive' }]);
    expect(JSON.stringify(c)).not.toContain(ctx.scope.organizationId); // no tenant ids in the prompt
  });

  it('flags truncated content instead of cutting it silently', async () => {
    const ctx = await seed('alice', { sectionText: 'a'.repeat(CONTEXT_LIMITS.maxSectionChars + 500) });
    const c = await buildAIContext(ctx.scope, ctx.opp.id);
    expect(c.page.content!.contentTruncated).toBe(true);
    expect(c.page.content!.sections[0]).toMatchObject({ truncated: true });
    expect(c.page.content!.sections[0]!.text.length).toBe(CONTEXT_LIMITS.maxSectionChars);
  });

  it('returns null content when the page has no crawled version (missing evidence)', async () => {
    const ctx = await seed('alice', { withVersion: false });
    expect((await buildAIContext(ctx.scope, ctx.opp.id)).page.content).toBeNull();
  });

  it('refuses to build context across tenants', async () => {
    const alice = await seed('alice');
    const bob = await seed('bob');
    await expect(buildAIContext(bob.scope, alice.opp.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(buildAIContext({ organizationId: alice.scope.organizationId, projectId: bob.scope.projectId }, alice.opp.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('analysis lifecycle', () => {
  it('queues a run (202), completes it, and serves the validated analysis', async () => {
    const ctx = await seed();
    const run = await analyze(ctx);
    expect(run).toMatchObject({ status: 'QUEUED', provider: 'fake', model: 'fake-model', promptVersion: 'opportunity-analysis-v1+recommendation-v1', contextVersion: 'opportunity-context-v1' });
    expect(await prisma.aIAnalysisRun.count()).toBe(1);

    await runAIAnalysis(run.id);
    const done = await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', attempts: 1, inputTokens: 2000, outputTokens: 400, errorCode: null });
    expect(done.startedAt).toBeTruthy();
    expect(done.completedAt).toBeTruthy();
    expect(done.latencyMs).toBeGreaterThanOrEqual(0);

    const res = (await ctx.get(`${API(ctx.project.id)}/${ctx.opp.id}/analysis`).expect(200)).body;
    expect(res.latestRun).toMatchObject({ id: run.id, status: 'COMPLETED' });
    expect(res.analysis).toMatchObject({ runId: run.id, summary: validAnalysis().summary, evidenceSufficient: true });
    expect(res.analysis.searchIntent[0]).toMatchObject({ query: 'react guide', intent: 'INFORMATIONAL' });
    expect(res.analysis.recommendations.recommendations).toHaveLength(2);
    expect(res.analysis.pageVersionId).toBeTruthy();

    // the provider saw the fresh context for this opportunity
    expect(fake.contexts[0]!.opportunity.id).toBe(ctx.opp.id);
    expect(await prisma.auditLog.count({ where: { action: { in: ['ai.analysis_requested', 'ai.analysis_completed'] } } })).toBe(2);
  });

  it('never changes the page, its content or the Phase 4 opportunity', async () => {
    const ctx = await seed();
    const before = await prisma.optimizationOpportunity.findUniqueOrThrow({ where: { id: ctx.opp.id } });
    const pageBefore = await prisma.contentPage.findUniqueOrThrow({ where: { id: ctx.page.id } });
    await runAIAnalysis((await analyze(ctx)).id);
    const after = await prisma.optimizationOpportunity.findUniqueOrThrow({ where: { id: ctx.opp.id } });
    expect(after).toMatchObject({ status: 'DETECTED', score: before.score, analysis: null });
    expect(await prisma.contentPage.findUniqueOrThrow({ where: { id: ctx.page.id } })).toMatchObject({ currentVersionId: pageBefore.currentVersionId, currentVersionNo: 1 });
    expect(await prisma.contentPageVersion.count()).toBe(1);
  });

  it('collapses duplicate requests into the active run', async () => {
    const ctx = await seed();
    const a = await analyze(ctx);
    const b = await analyze(ctx);
    expect(b.id).toBe(a.id);
    expect(await prisma.aIAnalysisRun.count()).toBe(1);
    // once finished, a new request creates a new run
    await runAIAnalysis(a.id);
    const c = await analyze(ctx);
    expect(c.id).not.toBe(a.id);
  });

  it('the database allows only one active run per opportunity', async () => {
    const ctx = await seed();
    const run = await analyze(ctx);
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: run.id } });
    await expect(prisma.aIAnalysisRun.create({ data: copy })).rejects.toThrow();
  });

  it('fails the run and stores nothing when output is schema-invalid', async () => {
    const ctx = await seed();
    fake.analyses = [new AIError('AI_OUTPUT_INVALID', 'Model output failed schema validation', false, { inputTokens: 900, outputTokens: 50 })];
    const run = await analyze(ctx);
    await expect(runAIAnalysis(run.id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'AI_OUTPUT_INVALID', inputTokens: 900 });
    expect(await prisma.opportunityAnalysis.count()).toBe(0);
    const res = (await ctx.get(`${API(ctx.project.id)}/${ctx.opp.id}/analysis`).expect(200)).body;
    expect(res.analysis).toBeNull();
    expect(res.latestRun).toMatchObject({ status: 'FAILED', errorCode: 'AI_OUTPUT_INVALID' });
  });

  it('fails ungrounded output (invented query, causal promise) without persisting it', async () => {
    const ctx = await seed();
    fake.analyses = [validAnalysis({ searchIntent: [{ query: 'angular tutorial', intent: 'INFORMATIONAL', confidence: 0.9, reasoning: 'r' }] })];
    const r1 = await analyze(ctx);
    await expect(runAIAnalysis(r1.id)).rejects.toThrow(/grounding/);
    expect(await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({ status: 'FAILED', errorCode: 'AI_OUTPUT_INVALID' });

    fake = new FakeAI();
    fake.recs = [{ recommendations: [], caveats: ['Changing the title will increase CTR.'] }];
    setAIProvider(fake);
    const r2 = await analyze(ctx);
    await expect(runAIAnalysis(r2.id)).rejects.toThrow(/grounding/);
    expect(await prisma.opportunityAnalysis.count()).toBe(0);
  });

  it('a page without crawled content still analyzes when the AI reports insufficient evidence', async () => {
    const ctx = await seed('alice', { withVersion: false });
    fake.analyses = [validAnalysis({ evidenceSufficient: false, insufficientEvidenceNotes: ['No crawled content is available.'], contentGaps: [] })];
    fake.recs = [{ recommendations: [], caveats: ['Crawl the page before reviewing content changes.'] }];
    const run = await analyze(ctx);
    await runAIAnalysis(run.id);
    expect(fake.contexts[0]!.page.content).toBeNull();
    const a = await prisma.opportunityAnalysis.findFirstOrThrow();
    expect(a.pageVersionId).toBeNull();
    expect(a.analysis).toMatchObject({ evidenceSufficient: false });
  });

  it('keeps the run RUNNING on a retryable provider error and completes on the next attempt', async () => {
    const ctx = await seed();
    fake.analyses = [new AIError('PROVIDER_RETRYABLE', 'Claude API rate limit reached', true), () => validAnalysis()];
    const run = await analyze(ctx);
    await expect(runAIAnalysis(run.id, 1)).rejects.toMatchObject({ code: 'PROVIDER_RETRYABLE' });
    expect(await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'RUNNING', errorCode: 'PROVIDER_RETRYABLE' });
    await runAIAnalysis(run.id, 2);
    expect(await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'COMPLETED', attempts: 2, errorCode: null });
  });

  it('fails permanently on a refusal or permanent provider error', async () => {
    const ctx = await seed();
    fake.analyses = [new AIError('AI_REFUSED', 'Model declined the request', false)];
    const run = await analyze(ctx);
    await expect(runAIAnalysis(run.id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'AI_REFUSED' });
    await expect(runAIAnalysis(run.id)).rejects.toThrow(/not runnable/); // a failed run is never re-processed
  });

  it('fails the run when the opportunity was dismissed after queuing', async () => {
    const ctx = await seed();
    const run = await analyze(ctx);
    await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/dismiss`).expect(200);
    await expect(runAIAnalysis(run.id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'CONTEXT_UNAVAILABLE' });
    expect(fake.calls.analyze).toBe(0);
  });

  it('refuses to analyze a dismissed opportunity (409)', async () => {
    const ctx = await seed();
    await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/dismiss`).expect(200);
    await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(409);
  });

  it('returns 503 when AI is not configured', async () => {
    setAIProvider(null); // test env has no ANTHROPIC_API_KEY
    const ctx = await seed();
    const res = await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(503);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
    expect(await prisma.aIAnalysisRun.count()).toBe(0);
  });
});

describe('BullMQ worker', () => {
  it('processes a queued analysis end to end', async () => {
    const ctx = await seed();
    const worker = startAIAnalysisWorker();
    try {
      const run = await analyze(ctx);
      const done = await waitFor(() => prisma.aIAnalysisRun.findFirst({ where: { id: run.id, status: { in: ['COMPLETED', 'FAILED'] } } }));
      expect(done.status).toBe('COMPLETED');
      expect(await prisma.opportunityAnalysis.count({ where: { runId: run.id } })).toBe(1);
    } finally {
      await worker.close();
    }
  });

  it('does not retry invalid output: one attempt, then FAILED', async () => {
    const ctx = await seed();
    fake.analyses = [new AIError('AI_OUTPUT_INVALID', 'bad output', false)];
    const worker = startAIAnalysisWorker();
    try {
      const run = await analyze(ctx);
      const done = await waitFor(() => prisma.aIAnalysisRun.findFirst({ where: { id: run.id, status: 'FAILED' } }));
      expect(done).toMatchObject({ errorCode: 'AI_OUTPUT_INVALID', attempts: 1 });
      expect(fake.calls.analyze).toBe(1);
    } finally {
      await worker.close();
    }
  });
});

describe('access control', () => {
  it('treats other tenants’ opportunities as 404', async () => {
    const alice = await seed('alice');
    const bob = await seed('bob');
    await bob.post(`${API(bob.project.id)}/${alice.opp.id}/analyze`).expect(404);
    await bob.get(`${API(bob.project.id)}/${alice.opp.id}/analysis`).expect(404);
    await bob.post(`${API(alice.project.id)}/${alice.opp.id}/analyze`).expect(404);
    await bob.get(`${API(alice.project.id)}/${alice.opp.id}/analysis`).expect(404);
    expect(await prisma.aIAnalysisRun.count()).toBe(0);
  });

  it('requires authentication, and EDITOR to analyze', async () => {
    const ctx = await seed();
    const anon = await client();
    await anon.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(401);
    await anon.get(`${API(ctx.project.id)}/${ctx.opp.id}/analysis`).expect(401);

    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: ctx.project.organizationId, role: 'VIEWER' } });
    await viewer.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(403);
    await viewer.get(`${API(ctx.project.id)}/${ctx.opp.id}/analysis`).expect(200);
  });
});
