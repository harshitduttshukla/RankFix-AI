import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/database.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { closeAIAnalysisQueue } from '../src/queues/ai-analysis.queue.js';
import { applyVerifyQueue, closeApplyVerifyQueue } from '../src/queues/apply-verify.queue.js';
import { closeCrawlQueue } from '../src/queues/crawl.queue.js';
import { opportunityRepository } from '../src/repositories/opportunity.repository.js';
import { setAIProvider } from '../src/services/ai/ai.provider.js';
import { runAIAnalysis } from '../src/services/ai/opportunity-analysis.service.js';
import { markVerificationCrashed, resumeApplyingRuns, runApplyVerification } from '../src/services/apply/apply.service.js';
import { runCrawl } from '../src/services/crawler/crawl-runner.js';
import { DEFAULT_POLICY, setNetworkPolicy } from '../src/services/crawler/safe-fetch.js';
import { encryptSecret } from '../src/utils/crypto.js';
import { FakeAI } from './ai-fixtures.js';
import { FixtureSite, testPolicy } from './fixture-server.js';
import { clientWithProject, resetDb } from './helpers.js';

/*
 * Phase 7a against the real test database, a local fixture website and the real crawler + verifier.
 * The fake AI only produces the recommendations a human then approves.
 */

let site: FixtureSite;
let fake: FakeAI;
const PATH = '/blog/react-guide';
const filler = 'This guide explains how components render, how props flow down the tree, and how state changes trigger updates across a typical application built with React today.';

interface PageSpec {
  title?: string;
  meta?: string;
  h1?: string;
  h2?: string;
  body?: string;
  extraSectionFirst?: boolean;
}
const html = (o: PageSpec = {}) => `<html><head><title>${o.title ?? 'React Guide'}</title><meta name="description" content="${o.meta ?? 'Learn React.'}"></head>
<body><main><h1>${o.h1 ?? 'React Guide'}</h1><p>${filler} ${filler}</p>
${o.extraSectionFirst ? '<h2>Extra section</h2><p>An extra section that was added later to the page.</p>' : ''}
<h2>${o.h2 ?? 'React hooks tutorial'}</h2>${(o.body ?? 'Hooks let you use state in function components.').split('\n\n').map((b) => `<p>${b}</p>`).join('')}
<h2>State management</h2><p>Context and reducers share state between components without prop drilling.</p></main></body></html>`;

const serve = (o: PageSpec = {}) => site.routes.set(PATH, html(o));

type C = Awaited<ReturnType<typeof clientWithProject>>;
const API = (projectId: string) => `/api/projects/${projectId}/optimization/opportunities`;

/** Project → fixture website → real crawl (v1) → opportunity → fake-AI analysis. */
async function seed(name = 'alice') {
  const c = await clientWithProject(name);
  const scope = { organizationId: c.project.organizationId, projectId: c.project.id };
  const website = await prisma.website.create({ data: { ...scope, baseUrl: site.url('blog.test').replace(/\/$/, ''), hostname: 'blog.test', blogPathPrefix: '/blog/' } });
  serve();
  const job = (await c.post(`/api/websites/${website.id}/crawl`).expect(202)).body;
  expect(await runCrawl(job.id)).toBe('COMPLETED');
  const page = await prisma.contentPage.findFirstOrThrow({ where: { websiteId: website.id } });
  const opp = await prisma.optimizationOpportunity.create({
    data: {
      ...scope,
      websiteId: website.id,
      pageId: page.id,
      pageUrl: page.url,
      pageTitle: 'React Guide',
      type: 'LOW_CTR',
      score: 72,
      scoreBreakdown: [],
      dateRangeStart: new Date('2026-09-01'),
      dateRangeEnd: new Date('2026-09-28'),
      clicks: 300,
      impressions: 30000,
      ctr: 0.01,
      position: 7.2,
      metrics: { current: { start: '2026-09-01', end: '2026-09-28', clicks: 300, impressions: 30000, ctr: 0.01, position: 7.2 }, previous: { start: '2026-08-04', end: '2026-08-31', clicks: 310, impressions: 29000, ctr: 0.0107, position: 7 }, expectedCtr: 0.038, queryCount: 3, coverageGaps: [], summary: 's' },
      evidence: [{ type: 'LOW_CTR', primary: true, metric: 'ctr', value: 1, threshold: 2.3, comparison: '<', text: 'CTR was 1.0%' }],
      topQueries: [
        { query: 'react guide', clicks: 120, impressions: 12000, ctr: 0.01, position: 6.5 },
        { query: 'react hooks tutorial', clicks: 80, impressions: 8000, ctr: 0.01, position: 7.4 },
        { query: 'react performance', clicks: 10, impressions: 3000, ctr: 0.0033, position: 9.1 },
      ],
    },
  });
  const run = (await c.post(`${API(c.project.id)}/${opp.id}/analyze`).expect(202)).body;
  await runAIAnalysis(run.id);
  const review = (await c.get(`${API(c.project.id)}/${opp.id}/review`).expect(200)).body;
  return { ...c, scope, website, page, opp, recs: review.recommendations as { id: string }[] };
}
type Ctx = Awaited<ReturnType<typeof seed>>;

const recUrl = (ctx: Ctx, i: number) => `${API(ctx.project.id)}/${ctx.opp.id}/recommendations/${ctx.recs[i]!.id}`;
const propUrl = (ctx: Ctx, id: string) => `${API(ctx.project.id)}/${ctx.opp.id}/proposals/${id}`;
const getReview = async (ctx: Ctx) => (await ctx.get(`${API(ctx.project.id)}/${ctx.opp.id}/review`).expect(200)).body;

/** Approves recommendation i as a concrete change, then gives the proposal its final approval. */
async function approved(ctx: Ctx, change: { proposedValue: string; changeType?: string; targetSection?: string }, i = 0) {
  const r = (await ctx.post(`${recUrl(ctx, i)}/approve`, change).expect(200)).body;
  const proposal = r.recommendations[i].proposals.at(-1);
  await ctx.post(`${propUrl(ctx, proposal.id)}/approve`, {}).expect(200);
  return proposal.id as string;
}

const markApplied = (ctx: Ctx, proposalId: string, status = 202) => ctx.post(`${propUrl(ctx, proposalId)}/mark-applied`).expect(status);
const runFor = (proposalId: string) => prisma.optimizationRun.findUniqueOrThrow({ where: { proposalId } });
async function verify(proposalId: string) {
  const run = await runFor(proposalId);
  return runApplyVerification(run.id, run.verificationAttempts);
}
const oppStatus = async (ctx: Ctx) => (await prisma.optimizationOpportunity.findUniqueOrThrow({ where: { id: ctx.opp.id } })).status;
const auditCount = (action: string) => prisma.auditLog.count({ where: { action } });

beforeAll(async () => {
  site = await new FixtureSite().start();
});
beforeEach(async () => {
  await resetDb();
  await redis().flushdb();
  setNetworkPolicy(testPolicy());
  site.routes.clear();
  site.hits = [];
  site.routes.set('/robots.txt', { type: 'text/plain', body: `User-agent: *\nAllow: /\nSitemap: ${site.url('blog.test', '/sitemap.xml')}` });
  site.routes.set('/sitemap.xml', { type: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site.url('blog.test', PATH)}</loc></url></urlset>` });
  fake = new FakeAI();
  setAIProvider(fake);
});
afterEach(() => {
  setAIProvider(null);
  setNetworkPolicy(testPolicy());
  vi.restoreAllMocks();
});
afterAll(async () => {
  setNetworkPolicy(DEFAULT_POLICY);
  await site.stop();
  await closeApplyVerifyQueue();
  await closeAIAnalysisQueue();
  await closeCrawlQueue();
  await closeRedis();
  await prisma.$disconnect();
});

describe('mark applied → verify', () => {
  it('waits while the old title is live, then verifies the approved title with a one-page crawl', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    expect(await oppStatus(ctx)).toBe('PROPOSED');
    const lastCrawled = (await prisma.website.findUniqueOrThrow({ where: { id: ctx.website.id } })).lastCrawledAt;

    const res = (await markApplied(ctx, proposalId)).body;
    expect(res.queued).toBe(true);
    const p = res.review.recommendations[0].proposals.at(-1);
    expect(p.apply).toMatchObject({ canMarkApplied: false, canRetry: false, run: { status: 'APPLYING', verificationAttempts: 1, baseline: null } });
    expect(await oppStatus(ctx)).toBe('APPLYING');
    expect(await applyVerifyQueue().getJob(`${p.apply.run.id}-1`)).toBeTruthy();
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'proposal.marked_applied' } })).toMatchObject({ actorUserId: ctx.user.id, metadata: expect.objectContaining({ baseline: { limitation: 'NO_GSC_PROPERTY' } }) });

    // The site still shows the old title.
    site.hits = [];
    expect(await verify(proposalId)).toMatchObject({ status: 'AWAITING_CHANGE' });
    expect(site.hits).toEqual(['/robots.txt', PATH]); // one page, no sitemap, no link discovery
    let run = await runFor(proposalId);
    expect(run).toMatchObject({ status: 'AWAITING_CHANGE', verificationError: null, verifiedAt: null });
    expect(await prisma.crawlJob.findUniqueOrThrow({ where: { id: run.lastCrawlJobId! } })).toMatchObject({ discoveryMethod: 'verification', pagesProcessed: 1 });
    expect((await prisma.website.findUniqueOrThrow({ where: { id: ctx.website.id } })).lastCrawledAt).toEqual(lastCrawled);
    expect(await prisma.contentPageVersion.count()).toBe(1); // unchanged content → no new version
    expect((await getReview(ctx)).recommendations[0].proposals.at(-1).apply).toMatchObject({ canRetry: true, run: { status: 'AWAITING_CHANGE', retryable: true } });

    // The customer updates their site, then retries.
    serve({ title: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'APPLIED' });
    run = await runFor(proposalId);
    const page = await prisma.contentPage.findUniqueOrThrow({ where: { id: ctx.page.id } });
    expect(run).toMatchObject({ status: 'APPLIED', verificationAttempts: 2, newVersionId: page.currentVersionId, previousVersionId: ctx.page.currentVersionId });
    expect(run.verifiedAt).toBeTruthy();
    expect(await prisma.optimizationProposal.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ status: 'APPLIED' });
    expect(await oppStatus(ctx)).toBe('APPLIED');
    expect(await auditCount('apply.verified')).toBe(1);
    expect(await auditCount('apply.verification_started')).toBe(2);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'apply.verification_failed' } })).toMatchObject({ metadata: expect.objectContaining({ reason: 'CHANGE_NOT_FOUND' }) });

    // Applied is final: marking again changes nothing.
    const again = (await markApplied(ctx, proposalId)).body;
    expect(again.queued).toBe(false);
    expect((await runFor(proposalId)).verificationAttempts).toBe(2);
  });

  it.each([
    ['META_DESCRIPTION', { changeType: 'META_DESCRIPTION', proposedValue: 'Learn React hooks and state.' }, { meta: 'Learn React hooks and state.' }, 0],
    ['H1', { changeType: 'H1', proposedValue: 'The React Guide' }, { h1: 'The React Guide' }, 0],
    ['SECTION_HEADING', { changeType: 'SECTION_HEADING', targetSection: 's1-react-hooks-tutorial', proposedValue: 'A React hooks tutorial' }, { h2: 'A React hooks tutorial' }, 1],
    [
      'SECTION_CONTENT',
      { changeType: 'SECTION_CONTENT', targetSection: 's1-react-hooks-tutorial', proposedValue: 'Hooks let you use state in function components.\n\nThey also replace most lifecycle methods.' },
      { body: 'Hooks let you use state in function components.\n\nThey also replace most lifecycle methods.' },
      1,
    ],
  ] as const)('verifies a %s change in the right field', async (_name, change, live, rec) => {
    const ctx = await seed();
    const proposalId = await approved(ctx, change, rec);
    await markApplied(ctx, proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'AWAITING_CHANGE' });
    serve(live);
    await markApplied(ctx, proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'APPLIED' });
  });

  it('a conflicting value fails as CONTENT_CONFLICT, never applied; fixing the page and retrying verifies it', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    serve({ title: 'Someone else’s title' });
    expect(await verify(proposalId)).toMatchObject({ status: 'FAILED', error: 'CONTENT_CONFLICT' });
    const run = await runFor(proposalId);
    expect(run.verificationDetail).toMatchObject({ result: 'CONFLICT', liveVersionNo: 2 });
    expect(JSON.stringify(run.verificationDetail)).not.toMatch(/<html|<main/); // no raw HTML in the record
    expect(await prisma.optimizationProposal.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ status: 'APPROVED' });
    expect(await oppStatus(ctx)).toBe('APPLYING');

    serve({ title: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'APPLIED' });
  });

  it('TARGET_MISSING when the page structure moved the heading being verified', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { changeType: 'SECTION_HEADING', targetSection: 's1-react-hooks-tutorial', proposedValue: 'A React hooks tutorial' }, 1);
    await markApplied(ctx, proposalId);
    serve({ h2: 'A React hooks tutorial', extraSectionFirst: true });
    expect(await verify(proposalId)).toMatchObject({ status: 'FAILED', error: 'TARGET_MISSING' });
  });

  it.each([
    ['404', { status: 404, body: 'gone' }, 'PAGE_GONE'],
    ['500', { status: 500, body: 'oops' }, 'FETCH_FAILED'],
    ['non-HTML', { type: 'application/pdf', body: '%PDF' }, 'NOT_HTML'],
    ['redirect', { status: 301, headers: { location: '/blog/other' } }, 'PAGE_REDIRECTED'],
  ] as const)('a %s response is a retryable failure, never an application', async (_n, route, error) => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    site.routes.set(PATH, route);
    site.routes.set('/blog/other', html({ title: 'React Guide: Hooks and State' }));
    expect(await verify(proposalId)).toMatchObject({ status: 'FAILED', error });
    expect(await prisma.optimizationProposal.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ status: 'APPROVED' });
    expect((await getReview(ctx)).recommendations[0].proposals.at(-1).apply.canRetry).toBe(true);
  });

  it('keeps SSRF protections: with the production network policy the fixture (loopback) is never contacted', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    serve({ title: 'React Guide: Hooks and State' });
    setNetworkPolicy(DEFAULT_POLICY);
    site.hits = [];
    expect(await verify(proposalId)).toMatchObject({ status: 'FAILED', error: 'FETCH_FAILED' });
    expect(site.hits).toEqual([]);
  });
});

describe('integrity and authorization', () => {
  it('rejects proposals that are not final-approved, tampered, or superseded', async () => {
    const ctx = await seed();
    const r = (await ctx.post(`${recUrl(ctx, 0)}/approve`, { proposedValue: 'React Guide: Hooks and State' }).expect(200)).body;
    const pending = r.recommendations[0].proposals[0].id;
    expect((await markApplied(ctx, pending, 409)).body.error.code).toBe('INVALID_STATE_TRANSITION');

    await ctx.post(`${propUrl(ctx, pending)}/approve`, {}).expect(200);
    await prisma.optimizationProposal.update({ where: { id: pending }, data: { proposedValue: 'Tampered title for React' } });
    expect((await markApplied(ctx, pending, 409)).body.error.code).toBe('PROPOSAL_INTEGRITY');
    await prisma.optimizationProposal.update({ where: { id: pending }, data: { proposedValue: 'React Guide: Hooks and State' } });

    await ctx.post(`${recUrl(ctx, 0)}/proposal`, { proposedValue: 'React Guide: A Second Revision' }).expect(201);
    expect((await markApplied(ctx, pending, 409)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await prisma.optimizationRun.count()).toBe(0);
  });

  it('rejects a stale page version, but accepts one that already carries the approved change', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    serve({ title: 'An unrelated new title' });
    const crawl = async () => runCrawl((await ctx.post(`/api/websites/${ctx.website.id}/crawl`).expect(202)).body.id);
    await crawl();
    expect((await markApplied(ctx, proposalId, 409)).body.error.code).toBe('STALE_CONTENT_VERSION');

    serve({ title: 'React Guide: Hooks and State' });
    await crawl();
    await markApplied(ctx, proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'APPLIED' });
  });

  it('cross-tenant requests get 404 and viewers get 403', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    const other = await clientWithProject('mallory');
    await other.post(`${propUrl(ctx, proposalId)}/mark-applied`).expect(404);
    await other.post(`${API(other.project.id)}/${ctx.opp.id}/proposals/${proposalId}/mark-applied`).expect(404);
    await other.post(`${API(ctx.project.id)}/${ctx.opp.id}/abandon`).expect(404);

    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: ctx.project.organizationId, role: 'VIEWER' } });
    await viewer.post(`${propUrl(ctx, proposalId)}/mark-applied`).expect(403);
    await viewer.post(`${API(ctx.project.id)}/${ctx.opp.id}/abandon`).expect(403);
    expect(await prisma.optimizationRun.count()).toBe(0);
  });
});

describe('idempotency and recovery', () => {
  it('concurrent duplicate requests create exactly one run', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    const results = await Promise.all([1, 2, 3].map(() => ctx.post(`${propUrl(ctx, proposalId)}/mark-applied`)));
    expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
    expect(await prisma.optimizationRun.count()).toBe(1);
    expect(await auditCount('proposal.marked_applied')).toBe(1);
    expect((await runFor(proposalId)).verificationAttempts).toBe(1);
  });

  it('duplicate and out-of-order worker deliveries cannot change a decided run', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    const run = await runFor(proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'AWAITING_CHANGE' });
    serve({ title: 'React Guide: Hooks and State' });
    expect(await runApplyVerification(run.id, 1)).toEqual({ skipped: true }); // redelivery of attempt 1
    await markApplied(ctx, proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'APPLIED' });
    expect(await runApplyVerification(run.id, 1)).toEqual({ skipped: true }); // stale attempt
    expect(await runApplyVerification(run.id, 2)).toEqual({ skipped: true }); // duplicate of the deciding attempt
    expect(await auditCount('apply.verified')).toBe(1);
  });

  it('a failed enqueue leaves a recoverable run: the resume sweep and a repeated request re-queue it', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    vi.spyOn(applyVerifyQueue(), 'add').mockRejectedValueOnce(new Error('redis down'));
    expect((await markApplied(ctx, proposalId)).body.queued).toBe(false);
    const run = await runFor(proposalId);
    expect(run.status).toBe('APPLYING');
    expect(await applyVerifyQueue().getJob(`${run.id}-1`)).toBeUndefined();

    expect(await resumeApplyingRuns(new Date(Date.now() + 1000))).toBe(1);
    expect(await applyVerifyQueue().getJob(`${run.id}-1`)).toBeTruthy();
    expect((await markApplied(ctx, proposalId)).body.queued).toBe(true); // same attempt, deduplicated job id
    expect((await runFor(proposalId)).verificationAttempts).toBe(1);
  });

  it('a crashed attempt is recorded as a retryable failure and can be resumed', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    const run = await runFor(proposalId);
    await markVerificationCrashed(run.id, 1, 'worker died');
    expect(await runFor(proposalId)).toMatchObject({ status: 'FAILED', verificationError: 'INTERNAL' });
    serve({ title: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    expect(await verify(proposalId)).toMatchObject({ status: 'APPLIED' });
  });
});

describe('baseline', () => {
  async function connectGsc(ctx: Ctx, opts: { synced?: boolean } = {}) {
    const connection = await prisma.gSCConnection.create({ data: { ...ctx.scope, connectedById: ctx.user.id, googleEmail: 'a@example.com', refreshTokenEnc: encryptSecret('test-refresh-token'), scope: 'x' } });
    const lastSyncedDate = new Date(Date.UTC(2026, 9, 10));
    return prisma.gSCProperty.create({
      data: { ...ctx.scope, connectionId: connection.id, websiteId: ctx.website.id, siteUrl: 'sc-domain:blog.test', permissionLevel: 'siteOwner', lastSyncedDate: opts.synced === false ? null : lastSyncedDate },
    });
  }
  const day = (d: number) => new Date(Date.UTC(2026, 9, d));
  const row = (property: { id: string }, ctx: Ctx, date: Date, page: string, clicks: number, impressions: number, position: number, query = '') => ({
    ...ctx.scope,
    propertyId: property.id,
    date,
    page,
    query,
    clicks,
    impressions,
    ctr: clicks / impressions,
    position,
  });

  it('is computed from stored rows for this page and property only, and captured once', async () => {
    {
      const ctx = await seed();
      const property = await connectGsc(ctx);
      const url = ctx.page.url;
      await prisma.gSCSearchAnalytics.createMany({
        data: [
          row(property, ctx, day(1), url, 10, 1000, 5),
          row(property, ctx, day(10), url, 30, 1000, 7),
          row(property, ctx, day(10), url, 5, 400, 6, 'react guide'),
          row(property, ctx, day(10), `${url}-other`, 999, 9999, 1), // another page
          row(property, ctx, new Date(Date.UTC(2026, 7, 1)), url, 500, 5000, 2), // before the window
        ],
      });
      const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
      await markApplied(ctx, proposalId);
      await markApplied(ctx, proposalId);
      const rows = await prisma.optimizationMeasurement.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'BASELINE',
        propertyId: property.id,
        pageUrl: url,
        clicks: 40,
        impressions: 2000,
        ctr: 0.02,
        position: 6, // impression-weighted
        daysWithData: 2,
        dataComplete: true, // stored data starts before the window
      });
      // window: 28 days ending at the last synced day (Oct 10), before the apply date and within final data
      expect(rows[0]!.windowEnd).toEqual(day(10));
      expect(rows[0]!.windowStart).toEqual(new Date(Date.UTC(2026, 8, 13)));
      expect((await getReview(ctx)).recommendations[0].proposals.at(-1).apply.run.baseline).toMatchObject({ clicks: 40, impressions: 2000, dataComplete: true });
    }
  });

  it('records no impressions as zero with no position, and incomplete coverage as incomplete', async () => {
    const ctx = await seed();
    const property = await connectGsc(ctx);
    await prisma.gSCSearchAnalytics.create({ data: row(property, ctx, day(9), `${ctx.page.url}-other`, 1, 10, 3) });
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    expect(await prisma.optimizationMeasurement.findFirstOrThrow()).toMatchObject({ clicks: 0, impressions: 0, position: null, daysWithData: 0, dataComplete: false });
  });

  it('stores nothing (and says why) when Search Console was never synced', async () => {
    const ctx = await seed();
    await connectGsc(ctx, { synced: false });
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    expect(await prisma.optimizationMeasurement.count()).toBe(0);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'proposal.marked_applied' } })).toMatchObject({ metadata: expect.objectContaining({ baseline: { limitation: 'GSC_NOT_SYNCED' } }) });
    expect(await prisma.gSCSearchAnalytics.count()).toBe(0);
  });
});

describe('opportunity lifecycle (LIFE-01)', () => {
  const detected = () => ({
    type: 'LOW_CTR' as const,
    score: 50,
    scoreBreakdown: [],
    evidence: [],
    topQueries: [],
    metrics: { current: { start: '2026-09-01', end: '2026-09-28', clicks: 1, impressions: 500, ctr: 0.002, position: 8 } },
  });
  const redetect = (ctx: Ctx) =>
    opportunityRepository.upsertDetected(
      { id: ctx.website.id, ...ctx.scope },
      { pageId: ctx.page.id, url: ctx.page.url, title: 'React Guide' },
      detected() as never,
      { runId: 'run-x', windowStart: new Date('2026-09-01'), windowEnd: new Date('2026-09-28'), snoozeSince: new Date(0), now: new Date() },
    );

  it('abandon closes proposals and the opportunity; detection may then find it again', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    expect(await redetect(ctx)).toBe('skipped'); // PROPOSED blocks a duplicate
    const r = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/abandon`, { reason: 'Not doing this now' }).expect(200)).body;
    expect(r.opportunity.status).toBe('REJECTED');
    expect(r.canAbandon).toBe(false);
    expect(await prisma.optimizationProposal.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ status: 'SUPERSEDED' });
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'opportunity.abandoned' } })).toMatchObject({ metadata: expect.objectContaining({ from: 'PROPOSED', to: 'REJECTED', reason: 'Not doing this now', proposalsSuperseded: 1 }) });
    await markApplied(ctx, proposalId, 409);
    expect(await redetect(ctx)).toBe('created');
    expect(await prisma.optimizationOpportunity.count({ where: { pageId: ctx.page.id, type: 'LOW_CTR', status: 'DETECTED' } })).toBe(1);
  });

  it('abandon during verification ends the run; a late worker result changes nothing', async () => {
    const ctx = await seed();
    const proposalId = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    await markApplied(ctx, proposalId);
    const run = await runFor(proposalId);
    await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/abandon`).expect(200);
    expect(await runFor(proposalId)).toMatchObject({ status: 'FAILED', verificationError: 'ABANDONED' });
    serve({ title: 'React Guide: Hooks and State' });
    expect(await runApplyVerification(run.id, 1)).toEqual({ skipped: true });
    await markApplied(ctx, proposalId, 409);
    expect(await oppStatus(ctx)).toBe('REJECTED');
  });

  it('an opportunity with a verified change stays APPLIED when its remaining work is abandoned', async () => {
    const ctx = await seed();
    const title = await approved(ctx, { proposedValue: 'React Guide: Hooks and State' });
    const heading = await approved(ctx, { changeType: 'SECTION_HEADING', targetSection: 's1-react-hooks-tutorial', proposedValue: 'A React hooks tutorial' }, 1);
    serve({ title: 'React Guide: Hooks and State' });
    await markApplied(ctx, title);
    expect(await verify(title)).toMatchObject({ status: 'APPLIED' });
    expect(await oppStatus(ctx)).toBe('APPLIED');
    await markApplied(ctx, heading);
    expect(await oppStatus(ctx)).toBe('APPLYING');
    expect(await verify(heading)).toMatchObject({ status: 'AWAITING_CHANGE' });
    await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/abandon`).expect(200);
    expect(await oppStatus(ctx)).toBe('APPLIED');
    expect(await runFor(title)).toMatchObject({ status: 'APPLIED' });
  });
});
