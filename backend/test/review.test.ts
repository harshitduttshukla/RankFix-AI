import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { closeAIAnalysisQueue } from '../src/queues/ai-analysis.queue.js';
import { auditRepository } from '../src/repositories/audit.repository.js';
import { AIError } from '../src/services/ai/ai.errors.js';
import { setAIProvider } from '../src/services/ai/ai.provider.js';
import { runAIAnalysis } from '../src/services/ai/opportunity-analysis.service.js';
import { setOriginalityChecker } from '../src/services/originality/originality.service.js';
import { proposalMatchesCurrentPage } from '../src/services/review/review.service.js';
import { FakeAI, validRecommendations } from './ai-fixtures.js';
import { client, clientWithProject, resetDb } from './helpers.js';

let fake: FakeAI;
beforeEach(async () => {
  await resetDb();
  await redis().flushdb();
  fake = new FakeAI();
  setAIProvider(fake);
});
afterEach(() => {
  setAIProvider(null);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeAIAnalysisQueue();
  await closeRedis();
  await prisma.$disconnect();
});

const API = (projectId: string) => `/api/projects/${projectId}/optimization/opportunities`;

/** Project → website → page v1 (title, meta, H1, 2 sections) → DETECTED opportunity. */
async function seed(name = 'alice') {
  const c = await clientWithProject(name);
  const host = `${name}.example.com`;
  const site = (await c.post(`/api/projects/${c.project.id}/websites`, { baseUrl: `https://${host}` }).expect(201)).body as { id: string };
  const scope = { organizationId: c.project.organizationId, projectId: c.project.id };
  const page = await prisma.contentPage.create({ data: { ...scope, websiteId: site.id, url: `https://${host}/blog/react-guide`, httpStatus: 200, lastCrawledAt: new Date() } });
  const v1 = await createVersion(scope.organizationId, page.id, 1, 'React Guide');
  const opp = await prisma.optimizationOpportunity.create({
    data: {
      ...scope,
      websiteId: site.id,
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
      metrics: {
        current: { start: '2026-09-01', end: '2026-09-28', clicks: 300, impressions: 30000, ctr: 0.01, position: 7.2 },
        previous: { start: '2026-08-04', end: '2026-08-31', clicks: 310, impressions: 29000, ctr: 0.0107, position: 7 },
        expectedCtr: 0.038,
        queryCount: 3,
        clickChangePercent: -3.2,
        ctrChangePercent: -6.5,
        positionChange: 0.2,
        coverageGaps: [],
        summary: 'summary',
      },
      evidence: [{ type: 'LOW_CTR', primary: true, metric: 'ctr', unit: 'percent', value: 1, threshold: 2.3, comparison: '<', text: 'CTR was 1.0%' }],
      topQueries: [
        { query: 'react guide', clicks: 120, impressions: 12000, ctr: 0.01, position: 6.5 },
        { query: 'react hooks tutorial', clicks: 80, impressions: 8000, ctr: 0.01, position: 7.4 },
        { query: 'react performance', clicks: 10, impressions: 3000, ctr: 0.0033, position: 9.1 },
      ],
    },
  });
  return { ...c, scope, site, page, v1, opp };
}
type Ctx = Awaited<ReturnType<typeof seed>>;

async function createVersion(organizationId: string, pageId: string, versionNo: number, title: string) {
  const v = await prisma.contentPageVersion.create({
    data: {
      organizationId,
      pageId,
      versionNo,
      source: 'CRAWL',
      title,
      metaDescription: 'Learn React.',
      h1: 'React Guide',
      seoMeta: {},
      headings: [{ level: 2, text: 'React hooks tutorial', order: 0 }],
      sections: [],
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
      wordCount: 900,
      contentHash: `h-${pageId}-${versionNo}`,
      pageSections: {
        create: [
          { organizationId, sectionKey: 's1-react-hooks-tutorial', order: 0, heading: 'React hooks tutorial', level: 2, html: '', text: 'Hooks let you use state.', wordCount: 400, blocks: [] },
          { organizationId, sectionKey: 's2-state-management', order: 1, heading: 'State management', level: 2, html: '', text: 'Context and reducers.', wordCount: 500, blocks: [] },
        ],
      },
    },
  });
  await prisma.contentPage.update({ where: { id: pageId }, data: { currentVersionId: v.id, currentVersionNo: versionNo } });
  return v;
}

/** Runs Phase 5 for real (with the fake provider) and returns the review payload. */
async function analyzed(ctx: Ctx) {
  const run = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(202)).body;
  await runAIAnalysis(run.id);
  return review(ctx);
}
const review = async (c: { get: Ctx['get'] }, ctx?: Ctx) => {
  const x = ctx ?? (c as Ctx);
  return (await c.get(`${API(x.project.id)}/${x.opp.id}/review`).expect(200)).body;
};
const recUrl = (ctx: Ctx, recId: string) => `${API(ctx.project.id)}/${ctx.opp.id}/recommendations/${recId}`;
const propUrl = (ctx: Ctx, propId: string) => `${API(ctx.project.id)}/${ctx.opp.id}/proposals/${propId}`;
const auditCount = (action: string) => prisma.auditLog.count({ where: { action } });

describe('review page', () => {
  it('reports analysis state through NO_ANALYSIS → QUEUED → COMPLETED and lists recommendations', async () => {
    const ctx = await seed();
    expect((await review(ctx)).analysisState).toBe('NO_ANALYSIS');
    const run = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(202)).body;
    expect((await review(ctx)).analysisState).toBe('QUEUED');
    await runAIAnalysis(run.id);

    const r = await review(ctx);
    expect(r.analysisState).toBe('COMPLETED');
    expect(r.opportunity).toMatchObject({ id: ctx.opp.id, type: 'LOW_CTR', status: 'DETECTED' });
    expect(r.page).toMatchObject({ id: ctx.page.id, currentVersionId: ctx.v1.id });
    expect(r.page.currentVersion.pageSections).toHaveLength(2);
    expect(r.analysis).toMatchObject({ pageVersionId: ctx.v1.id, pageVersionNo: 1, stale: false });
    expect(r.analysis.observations.length).toBeGreaterThan(0);
    expect(r.analysis.searchIntent[0].query).toBe('react guide');
    expect(r.recommendations).toHaveLength(2);
    expect(r.recommendations[0]).toMatchObject({ status: 'PENDING', suggestedChangeType: 'TITLE', currentValue: 'React Guide', edited: null });
    expect(r.recommendations[1]).toMatchObject({ suggestedChangeType: 'SECTION_CONTENT', currentValue: 'Hooks let you use state.' });
    expect(JSON.stringify(r)).not.toMatch(/You are an SEO analyst|sk-ant/); // no prompts or keys
  });

  it('reports FAILED when the latest run failed', async () => {
    const ctx = await seed();
    fake.analyses = [new AIError('AI_OUTPUT_INVALID', 'bad', false)];
    const run = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(202)).body;
    await runAIAnalysis(run.id).catch(() => undefined);
    const r = await review(ctx);
    expect(r.analysisState).toBe('FAILED');
    expect(r.latestRun).toMatchObject({ status: 'FAILED', errorCode: 'AI_OUTPUT_INVALID' });
  });
});

describe('recommendation decisions', () => {
  it('approve → concrete proposal bound to the analyzed version; then proposal approval freezes it', async () => {
    const ctx = await seed();
    const r0 = await analyzed(ctx);
    const rec = r0.recommendations[0];
    const r1 = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'React Guide: Hooks, State and Performance', currentValue: 'FORGED' }).expect(200)).body;

    const approved = r1.recommendations[0];
    expect(approved.status).toBe('APPROVED');
    expect(approved.proposals).toHaveLength(1);
    const p = approved.proposals[0];
    expect(p).toMatchObject({
      status: 'AWAITING_APPROVAL',
      changeType: 'TITLE',
      currentValue: 'React Guide', // read from the analyzed version, client value ignored
      proposedValue: 'React Guide: Hooks, State and Performance',
      source: 'HUMAN_EDITED', // the reviewer replaced the AI draft with their own wording
      pageVersionId: ctx.v1.id,
      pageVersionNo: 1,
      revision: 1,
      matchesCurrentPageVersion: true,
    });
    expect(r1.opportunity.status).toBe('REVIEWED');

    const r2 = (await ctx.post(`${propUrl(ctx, p.id)}/approve`, { comment: 'Looks right' }).expect(200)).body;
    expect(r2.recommendations[0].proposals[0]).toMatchObject({ status: 'APPROVED', approvedById: ctx.user.id, approvedAgainstVersionId: ctx.v1.id });
    expect(r2.opportunity.status).toBe('PROPOSED');
    const approval = await prisma.optimizationApproval.findUniqueOrThrow({ where: { proposalId: p.id } });
    expect(approval).toMatchObject({ decision: 'APPROVED', decidedById: ctx.user.id, comment: 'Looks right' });
    expect(approval.proposalHash).toMatch(/^[a-f0-9]{64}$/);

    for (const a of ['opportunity.reviewed', 'recommendation.approved', 'proposal.created', 'proposal.approved']) expect(await auditCount(a)).toBe(1);
    const evt = await prisma.auditLog.findFirstOrThrow({ where: { action: 'proposal.approved' } });
    expect(evt).toMatchObject({ organizationId: ctx.scope.organizationId, projectId: ctx.project.id, actorUserId: ctx.user.id });
    expect(evt.metadata).toMatchObject({ websiteId: ctx.site.id, opportunityId: ctx.opp.id, proposalId: p.id, opportunityStatus: { from: 'REVIEWED', to: 'PROPOSED' } });

    // nothing touched the live page
    expect(await prisma.contentPage.findUniqueOrThrow({ where: { id: ctx.page.id } })).toMatchObject({ currentVersionId: ctx.v1.id, currentVersionNo: 1 });
    expect(await prisma.contentPageVersion.count()).toBe(1);
  });

  it('keeps the AI original when a human edits, and marks the proposal as human-edited', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const edited = (await ctx.patch(recUrl(ctx, rec.id), { recommendation: "Update title to include 'Scaffolding Rental Mumbai'." }).expect(200)).body.recommendations[0];
    expect(edited.status).toBe('EDITED');
    expect(edited.original.recommendation).toBe(rec.original.recommendation);
    expect(edited.edited.recommendation).toBe("Update title to include 'Scaffolding Rental Mumbai'.");
    expect(edited.editedById).toBe(ctx.user.id);
    expect(edited.editedAt).toBeTruthy();
    expect(await auditCount('recommendation.edited')).toBe(1);

    const after = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'Scaffolding Rental Mumbai | React Guide' }).expect(200)).body;
    expect(after.recommendations[0].proposals[0].source).toBe('HUMAN_EDITED');
  });

  it('rejects with a reason; a rejected recommendation can never become a proposal', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const r = (await ctx.post(`${recUrl(ctx, rec.id)}/reject`, { reason: 'ALREADY_ADDRESSED', note: 'Title was updated last week' }).expect(200)).body.recommendations[0];
    expect(r).toMatchObject({ status: 'REJECTED', rejectionReason: 'ALREADY_ADDRESSED', rejectionNote: 'Title was updated last week', reviewedById: ctx.user.id });
    expect(await auditCount('recommendation.rejected')).toBe(1);

    await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New title' }).expect(409);
    await ctx.post(`${recUrl(ctx, rec.id)}/proposal`, { proposedValue: 'New title' }).expect(409);
    await ctx.patch(recUrl(ctx, rec.id), { recommendation: 'x' }).expect(409);
    expect(await prisma.optimizationProposal.count()).toBe(0);
    expect(await prisma.recommendationReview.count({ where: { id: rec.id } })).toBe(1); // kept for audit
  });

  it('rejects a duplicate approval', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200);
    await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'Another title' }).expect(409);
    expect(await prisma.optimizationProposal.count()).toBe(1);
  });

  it('two editors approving at the same time produce exactly one approval and one proposal', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const editor = await clientWithProject('eve');
    await prisma.membership.create({ data: { userId: editor.user.id, organizationId: ctx.project.organizationId, role: 'EDITOR' } });
    const results = await Promise.all([
      ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'Title A for React' }),
      editor.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'Title B for React' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.optimizationProposal.count()).toBe(1);
    expect(await auditCount('recommendation.approved')).toBe(1);
  });

  it('two editors approving the same proposal at the same time: one wins', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200)).body.recommendations[0].proposals[0];
    const editor = await clientWithProject('eve');
    await prisma.membership.create({ data: { userId: editor.user.id, organizationId: ctx.project.organizationId, role: 'EDITOR' } });
    const results = await Promise.all([ctx.post(`${propUrl(ctx, p.id)}/approve`), editor.post(`${propUrl(ctx, p.id)}/approve`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.optimizationApproval.count()).toBe(1);
  });

  it('validates the concrete change against the analyzed version', async () => {
    const ctx = await seed();
    const [title, section] = (await analyzed(ctx)).recommendations;
    await ctx.post(`${recUrl(ctx, title.id)}/approve`, { proposedValue: 'React Guide' }).expect(400); // identical
    await ctx.post(`${recUrl(ctx, title.id)}/approve`, { proposedValue: '   ' }).expect(400);
    await ctx.post(`${recUrl(ctx, title.id)}/approve`, { proposedValue: 'x'.repeat(201) }).expect(400);
    await ctx.post(`${recUrl(ctx, title.id)}/approve`, { proposedValue: 'ok', changeType: 'SECTION_CONTENT', targetSection: null }).expect(400);
    await ctx.post(`${recUrl(ctx, section.id)}/approve`, { proposedValue: 'New text', targetSection: 's9-missing' }).expect(400);
    await ctx.post(`${recUrl(ctx, section.id)}/approve`, { proposedValue: '<script>alert(1)</script>' }).expect(400);
    await ctx.post(`${recUrl(ctx, title.id)}/approve`, { proposedValue: 'ok', changeType: 'BODY' }).expect(400);
    expect(await prisma.optimizationProposal.count()).toBe(0);
    expect((await review(ctx)).recommendations[0].status).toBe('PENDING');

    const ok = (await ctx.post(`${recUrl(ctx, section.id)}/approve`, { proposedValue: 'Hooks let you use state and side effects. This section now covers useEffect.' }).expect(200)).body;
    expect(ok.recommendations[1].proposals[0]).toMatchObject({ changeType: 'SECTION_CONTENT', targetSection: 's1-react-hooks-tutorial', currentValue: 'Hooks let you use state.' });
  });

  it('a new proposal revision supersedes the previous one without mutating it', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const first = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'First React title' }).expect(200)).body.recommendations[0].proposals[0];
    await ctx.post(`${propUrl(ctx, first.id)}/approve`).expect(200);
    const r = (await ctx.post(`${recUrl(ctx, rec.id)}/proposal`, { proposedValue: 'Second React title' }).expect(201)).body.recommendations[0];
    expect(r.proposals.map((p: { revision: number; status: string; proposedValue: string }) => [p.revision, p.status, p.proposedValue])).toEqual([
      [1, 'SUPERSEDED', 'First React title'],
      [2, 'AWAITING_APPROVAL', 'Second React title'],
    ]);
    expect(r.proposals[1].supersedesId).toBe(first.id);
    expect(await auditCount('proposal.superseded')).toBe(1);
  });

  it('rejects a proposal and records the decision', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200)).body.recommendations[0].proposals[0];
    const r = (await ctx.post(`${propUrl(ctx, p.id)}/reject`, { reason: 'Too long' }).expect(200)).body;
    expect(r.recommendations[0].proposals[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'Too long', rejectedById: ctx.user.id });
    expect(await prisma.optimizationApproval.findUniqueOrThrow({ where: { proposalId: p.id } })).toMatchObject({ decision: 'REJECTED' });
    await ctx.post(`${propUrl(ctx, p.id)}/approve`).expect(409);
    expect(await auditCount('proposal.rejected')).toBe(1);
  });

  it('rolls back the whole approval when any step fails', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const real = auditRepository.record.bind(auditRepository);
    vi.spyOn(auditRepository, 'record').mockImplementation((entry, db) => {
      if (entry.action === 'proposal.created') throw new Error('audit store down');
      return real(entry, db);
    });
    await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(500);
    vi.restoreAllMocks();
    const r = await review(ctx);
    expect(r.recommendations[0].status).toBe('PENDING');
    expect(r.opportunity.status).toBe('DETECTED');
    expect(await prisma.optimizationProposal.count()).toBe(0);
    expect(await auditCount('recommendation.approved')).toBe(0);
  });

  it('leaves the Phase 5 analysis unchanged', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const before = await prisma.opportunityAnalysis.findFirstOrThrow();
    await ctx.patch(recUrl(ctx, rec.id), { recommendation: 'Edited text' }).expect(200);
    await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200);
    const after = await prisma.opportunityAnalysis.findFirstOrThrow();
    expect(after.analysis).toEqual(before.analysis);
    expect(after.recommendations).toEqual(before.recommendations);
  });
});

describe('staleness', () => {
  it('page version 1 → 2: analysis is STALE, approval requires re-analysis, audited once', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    await createVersion(ctx.scope.organizationId, ctx.page.id, 2, 'React Guide (updated)');

    const r = await review(ctx);
    expect(r.analysisState).toBe('STALE');
    expect(r.analysis).toMatchObject({ stale: true, staleReason: 'PAGE_VERSION_CHANGED' });
    await review(ctx);
    expect(await auditCount('analysis.marked_stale')).toBe(1);

    const res = await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'ANALYSIS_STALE' });
    expect(res.body.error.message).toMatch(/Re-analysis required/);
  });

  it('significant change in GSC evidence makes the analysis stale (deterministic rule)', async () => {
    const ctx = await seed();
    await analyzed(ctx);
    await prisma.optimizationOpportunity.update({ where: { id: ctx.opp.id }, data: { impressions: 31000 } }); // +3%: still fresh
    expect((await review(ctx)).analysisState).toBe('COMPLETED');
    await prisma.optimizationOpportunity.update({ where: { id: ctx.opp.id }, data: { impressions: 15000 } }); // -50%
    const r = await review(ctx);
    expect(r.analysisState).toBe('STALE');
    expect(r.analysis.staleReason).toBe('EVIDENCE_CHANGED');
  });

  it('a proposal created on v1 cannot be approved after the page moves to v2, and Phase 7 can detect the mismatch', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200)).body.recommendations[0].proposals[0];
    await createVersion(ctx.scope.organizationId, ctx.page.id, 2, 'Changed');
    await ctx.post(`${propUrl(ctx, p.id)}/approve`).expect(409);
    expect(await proposalMatchesCurrentPage(ctx.scope, p.id)).toMatchObject({ matches: false, pageVersionId: ctx.v1.id });
    expect((await review(ctx)).recommendations[0].proposals[0].matchesCurrentPageVersion).toBe(false);
  });

  it('an approved proposal shows a version mismatch once the page changes', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200)).body.recommendations[0].proposals[0];
    await ctx.post(`${propUrl(ctx, p.id)}/approve`).expect(200);
    expect(await proposalMatchesCurrentPage(ctx.scope, p.id)).toMatchObject({ status: 'APPROVED', matches: true });
    await createVersion(ctx.scope.organizationId, ctx.page.id, 2, 'Changed');
    expect(await proposalMatchesCurrentPage(ctx.scope, p.id)).toMatchObject({ status: 'APPROVED', matches: false });
  });

  it('re-analysis creates a new run and analysis, keeps history, and retires the old recommendations', async () => {
    const ctx = await seed();
    const oldRec = (await analyzed(ctx)).recommendations[0];
    const v2 = await createVersion(ctx.scope.organizationId, ctx.page.id, 2, 'React Guide v2');
    const run = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/reanalyze`).expect(202)).body;
    const again = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/reanalyze`).expect(202)).body;
    expect(again.id).toBe(run.id); // no duplicate run
    const evt = await prisma.auditLog.findFirstOrThrow({ where: { action: 'analysis.reanalysis_requested' } });
    expect(evt.metadata).toMatchObject({ reason: 'PAGE_VERSION_CHANGED' });
    expect(await auditCount('analysis.reanalysis_requested')).toBe(1);

    await runAIAnalysis(run.id);
    const r = await review(ctx);
    expect(r.analysisState).toBe('COMPLETED');
    expect(r.analysis.pageVersionId).toBe(v2.id);
    expect(r.recommendations[0].id).not.toBe(oldRec.id);
    expect(r.recommendations[0].currentValue).toBe('React Guide v2');
    expect(await prisma.opportunityAnalysis.count()).toBe(2);
    expect(await prisma.aIAnalysisRun.count()).toBe(2);

    const res = await ctx.post(`${recUrl(ctx, oldRec.id)}/approve`, { proposedValue: 'New React title' }).expect(409);
    expect(res.body.error.message).toMatch(/older analysis/);
  });
});

describe('opportunity workflow', () => {
  it('REVIEWED → REJECTED supersedes live proposals; DETECTED cannot be rejected', async () => {
    const ctx = await seed();
    await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/reject`, { reason: 'x' }).expect(409);
    const rec = (await analyzed(ctx)).recommendations[0];
    await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200);
    const res = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/reject`, { reason: 'Seasonal page' }).expect(200)).body;
    expect(res).toMatchObject({ status: 'REJECTED' });
    expect(await prisma.optimizationProposal.findFirstOrThrow()).toMatchObject({ status: 'SUPERSEDED' });
    expect(await auditCount('opportunity.rejected')).toBe(1);
    await ctx.post(`${recUrl(ctx, (await review(ctx)).recommendations[1].id)}/approve`, { proposedValue: 'x y z' }).expect(409);
  });

  it('Phase 4 detection leaves REVIEWED/PROPOSED opportunities open and does not clear them', async () => {
    const { opportunityRepository } = await import('../src/repositories/opportunity.repository.js');
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200);
    expect(await opportunityRepository.clearStale(ctx.scope, ctx.site.id, 'another-run', new Date())).toBe(0);
    expect((await prisma.optimizationOpportunity.findUniqueOrThrow({ where: { id: ctx.opp.id } })).status).toBe('REVIEWED');
  });
});

describe('opportunity list', () => {
  it('keeps opportunities in review (REVIEWED/PROPOSED) in the default open list', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(200)).body.recommendations[0].proposals[0];
    await ctx.post(`${propUrl(ctx, p.id)}/approve`).expect(200);
    const list = (await ctx.get(API(ctx.project.id)).expect(200)).body;
    expect(list.items.map((i: { id: string; status: string }) => [i.id, i.status])).toEqual([[ctx.opp.id, 'PROPOSED']]);
  });
});

describe('access control', () => {
  it('404 for unknown recommendation, proposal or opportunity ids', async () => {
    const ctx = await seed();
    await analyzed(ctx);
    await ctx.post(`${recUrl(ctx, 'doesnotexist')}/approve`, { proposedValue: 'x' }).expect(404);
    await ctx.post(`${propUrl(ctx, 'doesnotexist')}/approve`).expect(404);
    await ctx.get(`${API(ctx.project.id)}/doesnotexist/review`).expect(404);
  });

  it('cross-tenant access is 404 everywhere', async () => {
    const alice = await seed('alice');
    const rec = (await analyzed(alice)).recommendations[0];
    const bob = await seed('bob');
    const bobRec = (await analyzed(bob)).recommendations[0];

    await bob.get(`${API(alice.project.id)}/${alice.opp.id}/review`).expect(404);
    await bob.get(`${API(bob.project.id)}/${alice.opp.id}/review`).expect(404);
    await bob.post(`${API(bob.project.id)}/${bob.opp.id}/recommendations/${rec.id}/approve`, { proposedValue: 'x' }).expect(404); // alice's rec via bob's opp
    await bob.patch(`${API(alice.project.id)}/${alice.opp.id}/recommendations/${rec.id}`, { recommendation: 'x' }).expect(404);
    await bob.post(`${API(alice.project.id)}/${alice.opp.id}/reanalyze`).expect(404);
    await alice.post(`${API(alice.project.id)}/${alice.opp.id}/recommendations/${bobRec.id}/reject`).expect(404);
    expect((await review(alice)).recommendations[0].status).toBe('PENDING');
  });

  it('viewers can read the review but cannot decide; anonymous users get 401', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: ctx.project.organizationId, role: 'VIEWER' } });
    await viewer.get(`${API(ctx.project.id)}/${ctx.opp.id}/review`).expect(200);
    await viewer.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'New React title' }).expect(403);
    await viewer.post(`${recUrl(ctx, rec.id)}/reject`).expect(403);
    await viewer.patch(recUrl(ctx, rec.id), { recommendation: 'x' }).expect(403);
    await viewer.post(`${recUrl(ctx, rec.id)}/proposal`, { proposedValue: 'x' }).expect(403);
    await viewer.post(`${API(ctx.project.id)}/${ctx.opp.id}/reanalyze`).expect(403);
    await viewer.post(`${API(ctx.project.id)}/${ctx.opp.id}/reject`).expect(403);
    const anon = await client();
    await anon.get(`${API(ctx.project.id)}/${ctx.opp.id}/review`).expect(401);
    expect(await prisma.optimizationProposal.count()).toBe(0);
  });
});

describe('AI drafts', () => {
  const draftUrl = (ctx: Ctx, recId: string) => `${recUrl(ctx, recId)}/draft`;

  it('shows the validated analysis draft as the starting value; content recommendations get none', async () => {
    const ctx = await seed();
    const r = await analyzed(ctx);
    expect(r.recommendations[0]).toMatchObject({ draftable: true, draft: { id: null, revision: 0, value: 'React Guide: React Hooks Tutorial' }, draftIssues: [], draftRegenerationsLeft: 5 });
    expect(r.recommendations[1]).toMatchObject({ draftable: false, draft: null, drafts: [] });
    const analysis = await prisma.opportunityAnalysis.findFirstOrThrow();
    expect(analysis.promptVersion).toBe('opportunity-analysis-v1+recommendation-v2');
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'ai.analysis_completed' } })).toMatchObject({ metadata: expect.objectContaining({ drafts: { kept: 1, discarded: 0 } }) });
  });

  it('drops an unsupported draft but keeps the recommendation; the reviewer writes the copy', async () => {
    const ctx = await seed();
    const set = validRecommendations();
    set.recommendations[0]!.suggestedValue = 'React Guide from ₹499 per day in Mumbai';
    fake.recs = [set];
    const r = await analyzed(ctx);
    expect(r.analysisState).toBe('COMPLETED');
    expect(r.recommendations[0]).toMatchObject({ draft: null, effective: { type: 'TITLE', suggestedValue: null } });
    expect(r.recommendations[0].draftIssues.join()).toMatch(/499|₹|Mumbai/);
    const p = (await ctx.post(`${recUrl(ctx, r.recommendations[0].id)}/approve`, { proposedValue: 'React Guide: Hooks and State' }).expect(200)).body.recommendations[0].proposals[0];
    expect(p.source).toBe('AI_RECOMMENDATION'); // no draft was offered
  });

  it('a draft with promissory wording still fails the whole run (overclaim check unchanged)', async () => {
    const ctx = await seed();
    const set = validRecommendations();
    set.recommendations[0]!.suggestedValue = 'React Guide that will increase your clicks';
    fake.recs = [set];
    const run = (await ctx.post(`${API(ctx.project.id)}/${ctx.opp.id}/analyze`).expect(202)).body;
    await expect(runAIAnalysis(run.id)).rejects.toThrow(/grounding/);
    expect((await review(ctx)).analysisState).toBe('FAILED');
    expect(await prisma.opportunityAnalysis.count()).toBe(0);
  });

  it('approving the unedited draft records an AI_DRAFT proposal; the AI original stays immutable', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const r = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: rec.draft.value }).expect(200)).body;
    expect(r.recommendations[0].proposals[0]).toMatchObject({ source: 'AI_DRAFT', draftId: null, proposedValue: 'React Guide: React Hooks Tutorial', currentValue: 'React Guide', pageVersionId: ctx.v1.id });
    const evt = await prisma.auditLog.findFirstOrThrow({ where: { action: 'proposal.created' } });
    expect(evt.metadata).toMatchObject({ source: 'AI_DRAFT', draftId: null, draftRevision: 0 });
    const stored = await prisma.recommendationReview.findUniqueOrThrow({ where: { id: rec.id } });
    expect(stored.original).toMatchObject({ suggestedValue: 'React Guide: React Hooks Tutorial' });
    expect(stored.edited).toBeNull();
  });

  it('a reviewer can request a new draft: stored as a new revision, earlier drafts and the original kept', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const r = (await ctx.post(draftUrl(ctx, rec.id)).expect(201)).body.recommendations[0];
    expect(fake.draftRequests[0]!.previous).toEqual(['React Guide: React Hooks Tutorial']);
    expect(r.draft).toMatchObject({ revision: 1, value: 'React Guide covering the React hooks tutorial', note: 'Names the hooks section.' });
    expect(r.drafts.map((d: { revision: number }) => d.revision)).toEqual([0, 1]);
    expect(r.draftRegenerationsLeft).toBe(4);
    const row = await prisma.recommendationDraft.findFirstOrThrow();
    expect(row).toMatchObject({ revision: 1, pageVersionId: ctx.v1.id, promptVersion: 'draft-v1', provider: 'fake', requestedById: ctx.user.id, organizationId: ctx.scope.organizationId });
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'recommendation.draft_generated' } })).toMatchObject({ actorUserId: ctx.user.id, metadata: expect.objectContaining({ draftId: row.id, draftRevision: 1 }) });
    expect((await prisma.recommendationReview.findUniqueOrThrow({ where: { id: rec.id } })).original).toMatchObject({ suggestedValue: 'React Guide: React Hooks Tutorial' });

    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: r.draft.value }).expect(200)).body.recommendations[0].proposals[0];
    expect(p).toMatchObject({ source: 'AI_DRAFT', draftId: row.id });
    const edited = (await ctx.post(`${recUrl(ctx, rec.id)}/proposal`, { proposedValue: 'React Guide: my own hooks title' }).expect(201)).body.recommendations[0].proposals;
    expect(edited.map((x: { source: string; status: string }) => [x.source, x.status])).toEqual([['AI_DRAFT', 'SUPERSEDED'], ['HUMAN_EDITED', 'AWAITING_APPROVAL']]);
  });

  it('an invalid, empty or repeated regenerated draft is discarded and audited; nothing is stored', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    fake.drafts = [
      { suggestedValue: 'React Guide: hooks from $49, rated #1 in London', note: '' },
      { suggestedValue: null, note: 'The page has too little detail.' },
      { suggestedValue: 'React Guide: React Hooks Tutorial', note: '' },
      new AIError('AI_OUTPUT_INVALID', 'Model output was not valid JSON', false),
    ];
    const bad = (await ctx.post(draftUrl(ctx, rec.id)).expect(502)).body;
    expect(bad.error.code).toBe('AI_OUTPUT_INVALID');
    expect(bad.error.message).toMatch(/discarded/);
    expect((await ctx.post(draftUrl(ctx, rec.id)).expect(422)).body.error.message).toMatch(/too little detail/);
    expect((await ctx.post(draftUrl(ctx, rec.id)).expect(502)).body.error.message).toMatch(/repeats an earlier draft/);
    await ctx.post(draftUrl(ctx, rec.id)).expect(502);
    expect(await prisma.recommendationDraft.count()).toBe(0);
    expect(await auditCount('recommendation.draft_failed')).toBe(4);
    expect((await review(ctx)).recommendations[0].draft).toMatchObject({ revision: 0 });
  });

  it('regeneration is refused for stale analyses, rejected or non-draftable recommendations, and past the limit', async () => {
    const ctx = await seed();
    const r = await analyzed(ctx);
    await ctx.post(draftUrl(ctx, r.recommendations[1].id)).expect(400); // SECTION_EXPANSION
    await ctx.post(`${recUrl(ctx, r.recommendations[1].id)}/reject`, { reason: 'NOT_RELEVANT' }).expect(200);
    await ctx.post(draftUrl(ctx, r.recommendations[1].id)).expect(409);

    const id = r.recommendations[0].id;
    fake.drafts = [1, 2, 3, 4, 5, 6].map((n) => ({ suggestedValue: `React Guide: React hooks tutorial part ${['one', 'two', 'three', 'four', 'five', 'six'][n - 1]}`, note: '' }));
    for (let i = 0; i < 5; i++) await ctx.post(draftUrl(ctx, id)).expect(201);
    await ctx.post(draftUrl(ctx, id)).expect(429);
    expect(await prisma.recommendationDraft.count()).toBe(5);

    await createVersion(ctx.scope.organizationId, ctx.page.id, 2, 'React Guide v2');
    expect((await ctx.post(draftUrl(ctx, id)).expect(409)).body.error.code).toBe('ANALYSIS_STALE');
  });

  it('a new draft never changes an approved proposal', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: rec.draft.value }).expect(200)).body.recommendations[0].proposals[0];
    await ctx.post(`${propUrl(ctx, p.id)}/approve`).expect(200);
    const before = await prisma.optimizationProposal.findUniqueOrThrow({ where: { id: p.id } });
    await ctx.post(draftUrl(ctx, rec.id)).expect(201);
    const after = await prisma.optimizationProposal.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toEqual(before);
    expect(after.status).toBe('APPROVED');
  });

  it('editing the type or target drops the draft from the edited copy, but not from the original', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    await ctx.post(draftUrl(ctx, rec.id)).expect(201);
    const r = (await ctx.patch(recUrl(ctx, rec.id), { type: 'HEADING' }).expect(200)).body.recommendations[0];
    expect(r).toMatchObject({ effective: { type: 'HEADING', suggestedValue: null }, original: { suggestedValue: 'React Guide: React Hooks Tutorial' }, draft: null });
    expect(await prisma.recommendationDraft.count()).toBe(1); // history kept
    const p = (await ctx.post(`${recUrl(ctx, rec.id)}/approve`, { proposedValue: 'React Guide: React Hooks Tutorial' }).expect(200)).body.recommendations[0].proposals[0];
    expect(p).toMatchObject({ changeType: 'H1', source: 'HUMAN_EDITED' });
  });

  it('viewers cannot request drafts; other tenants get 404', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: ctx.project.organizationId, role: 'VIEWER' } });
    await viewer.post(draftUrl(ctx, rec.id)).expect(403);
    const bob = await seed('bob');
    await bob.post(`${API(bob.project.id)}/${bob.opp.id}/recommendations/${rec.id}/draft`).expect(404);
    await bob.post(`${API(ctx.project.id)}/${ctx.opp.id}/recommendations/${rec.id}/draft`).expect(404);
    expect(await prisma.recommendationDraft.count()).toBe(0);
    expect(fake.calls.draft).toBe(0);
  });
});

describe('content originality', () => {
  const COPIED = 'We supply H-frame and Cuplock scaffolding to construction sites across the western suburbs with erection and dismantling crews available on request.';
  const ORIGINAL_META = 'A practical React guide that walks through the React hooks tutorial and state management with Context and reducers for new developers.';
  const checkUrl = (ctx: Ctx, recId: string) => `${recUrl(ctx, recId)}/originality`;
  const saved = { policy: env.ORIGINALITY_POLICY, requireCheck: env.ORIGINALITY_REQUIRE_CHECK, ttl: env.ORIGINALITY_RESULT_TTL_MINUTES };
  afterEach(() => {
    env.ORIGINALITY_POLICY = saved.policy;
    env.ORIGINALITY_REQUIRE_CHECK = saved.requireCheck;
    env.ORIGINALITY_RESULT_TTL_MINUTES = saved.ttl;
    setOriginalityChecker(undefined);
  });

  /** Another crawled page of the same website whose section text is `text`. */
  async function otherPage(ctx: Ctx, slug: string, text: string) {
    const page = await prisma.contentPage.create({ data: { ...ctx.scope, websiteId: ctx.site.id, url: `https://${ctx.site.id}.example.com/${slug}`, httpStatus: 200, lastCrawledAt: new Date() } });
    const v = await prisma.contentPageVersion.create({
      data: {
        organizationId: ctx.scope.organizationId, pageId: page.id, versionNo: 1, source: 'CRAWL', title: `Other ${slug}`, seoMeta: {}, headings: [], sections: [], bodyHtml: '', bodyText: text, wordCount: 30, contentHash: `h-${page.id}`,
        pageSections: { create: [{ organizationId: ctx.scope.organizationId, sectionKey: 's0-intro', order: 0, heading: null, level: 0, html: '', text, wordCount: 30, blocks: [] }] },
      },
    });
    await prisma.contentPage.update({ where: { id: page.id }, data: { currentVersionId: v.id, currentVersionNo: 1 } });
    return page;
  }
  const approveMeta = (ctx: Ctx, recId: string, proposedValue: string, ack?: string) =>
    ctx.post(`${recUrl(ctx, recId)}/approve`, { proposedValue, changeType: 'META_DESCRIPTION', ...(ack ? { acknowledgeOriginalityCheckId: ack } : {}) });

  it('checks the final text at approval and records the result on the proposal (no matches)', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    await otherPage(ctx, 'other', COPIED);
    const p = (await approveMeta(ctx, rec.id, ORIGINAL_META).expect(200)).body.recommendations[0].proposals[0];
    expect(p).toMatchObject({ originalityStatus: 'CHECKED', originalityAcknowledgedAt: null });
    const check = await prisma.originalityCheck.findUniqueOrThrow({ where: { id: p.originalityCheckId } });
    expect(check).toMatchObject({ status: 'CHECKED', assessment: 'NO_MATCHES', text: ORIGINAL_META, changeType: 'META_DESCRIPTION', pageVersionId: ctx.v1.id, checker: 'internal-corpus', checkerVersion: 'internal-ngram-v1', checkedById: ctx.user.id });
    const evt = await prisma.auditLog.findFirstOrThrow({ where: { action: 'originality.checked' } });
    expect(evt.metadata).toMatchObject({ checkId: check.id, textLength: ORIGINAL_META.length, assessment: 'NO_MATCHES' });
    expect(JSON.stringify(evt.metadata)).not.toContain('practical React guide'); // the text is never logged
  });

  it('significant matches need acknowledgment of the check of that exact text; edited text needs a new one', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const other = await otherPage(ctx, 'other', COPIED);

    const blocked = (await approveMeta(ctx, rec.id, COPIED).expect(409)).body.error;
    expect(blocked.code).toBe('ORIGINALITY_ACK_REQUIRED');
    const check = blocked.details.originality;
    expect(check).toMatchObject({ status: 'CHECKED', assessment: 'SIGNIFICANT_MATCHES' });
    expect(check.matches[0]).toMatchObject({ severity: 'SIGNIFICANT', source: { pageId: other.id, url: other.url } });
    expect(check.limitations.join(' ')).toMatch(/not .*plagiarism-free/);
    expect(await prisma.optimizationProposal.count()).toBe(0);

    // Acknowledging a check of different (stale) text does not count; the edited text gets its own check.
    const edited = `${COPIED} Call today.`;
    const again = (await approveMeta(ctx, rec.id, edited, check.id).expect(409)).body.error.details.originality;
    expect(again.id).not.toBe(check.id);

    const r = (await approveMeta(ctx, rec.id, edited, again.id).expect(200)).body.recommendations[0];
    expect(r.proposals[0]).toMatchObject({ originalityCheckId: again.id, originalityStatus: 'CHECKED', originalityAcknowledgedById: ctx.user.id, source: 'HUMAN_EDITED' });
    expect(await auditCount('originality.acknowledged')).toBe(1);

    // Final approval reuses the fresh result and the acknowledgment made for it.
    await ctx.post(`${propUrl(ctx, r.proposals[0].id)}/approve`).expect(200);
    expect(await prisma.originalityCheck.count()).toBe(2);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'proposal.approved' } })).metadata).toMatchObject({ originality: { checkId: again.id, acknowledged: true } });
  });

  it('a stale (expired) result is re-checked at final approval and new matches need acknowledgment', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    const p = (await approveMeta(ctx, rec.id, COPIED).expect(200)).body.recommendations[0].proposals[0]; // nothing to match yet
    await otherPage(ctx, 'later', COPIED); // crawled afterwards
    env.ORIGINALITY_RESULT_TTL_MINUTES = 0;
    const err = (await ctx.post(`${propUrl(ctx, p.id)}/approve`).expect(409)).body.error;
    expect(err.code).toBe('ORIGINALITY_ACK_REQUIRED');
    env.ORIGINALITY_RESULT_TTL_MINUTES = saved.ttl;
    await ctx.post(`${propUrl(ctx, p.id)}/approve`, { acknowledgeOriginalityCheckId: err.details.originality.id }).expect(200);
    expect((await prisma.optimizationProposal.findUniqueOrThrow({ where: { id: p.id } })).proposedValue).toBe(COPIED); // proposal itself unchanged
  });

  it('block and warn policies', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    await otherPage(ctx, 'other', COPIED);
    env.ORIGINALITY_POLICY = 'block';
    expect((await approveMeta(ctx, rec.id, COPIED).expect(409)).body.error.code).toBe('ORIGINALITY_BLOCKED');
    env.ORIGINALITY_POLICY = 'warn';
    const p = (await approveMeta(ctx, rec.id, COPIED).expect(200)).body.recommendations[0].proposals[0];
    expect(p).toMatchObject({ originalityStatus: 'CHECKED', originalityAcknowledgedAt: null });
    expect((await prisma.originalityCheck.findUniqueOrThrow({ where: { id: p.originalityCheckId } })).assessment).toBe('SIGNIFICANT_MATCHES');
  });

  it('a failed check is stored as CHECK_FAILED and blocks approval when required; never shown as "no matches"', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    setOriginalityChecker({ name: 'broken', version: 'x', check: async () => { throw new Error(`boom ${ORIGINAL_META}`); } });
    const err = (await approveMeta(ctx, rec.id, ORIGINAL_META).expect(503)).body.error;
    expect(err.code).toBe('ORIGINALITY_CHECK_FAILED');
    expect(err.details.originality).toMatchObject({ status: 'CHECK_FAILED', assessment: null, matches: [], error: { code: 'CHECKER_ERROR' } });
    expect(JSON.stringify(err)).not.toContain('boom');
    expect(await prisma.optimizationProposal.count()).toBe(0);
    expect(await auditCount('originality.check_failed')).toBe(1);

    env.ORIGINALITY_REQUIRE_CHECK = false;
    const p = (await approveMeta(ctx, rec.id, ORIGINAL_META).expect(200)).body.recommendations[0].proposals[0];
    expect(p.originalityStatus).toBe('CHECK_FAILED');
  });

  it('reviewers can check a draft or their edit and run it again; results are kept and listed', async () => {
    const ctx = await seed();
    const rec = (await analyzed(ctx)).recommendations[0];
    await otherPage(ctx, 'other', COPIED);
    const first = (await ctx.post(checkUrl(ctx, rec.id), { text: rec.draft.value }).expect(201)).body;
    expect(first).toMatchObject({ status: 'CHECKED', changeType: 'TITLE', text: 'React Guide: React Hooks Tutorial', assessment: 'NO_MATCHES' });
    const second = (await ctx.post(checkUrl(ctx, rec.id), { text: COPIED, changeType: 'META_DESCRIPTION' }).expect(201)).body;
    expect(second.assessment).toBe('SIGNIFICANT_MATCHES');
    await ctx.post(checkUrl(ctx, rec.id), { text: COPIED, changeType: 'META_DESCRIPTION' }).expect(201); // run again → new row
    expect(await prisma.originalityCheck.count()).toBe(3);

    await ctx.post(checkUrl(ctx, rec.id), { text: '   ' }).expect(400);
    await ctx.post(checkUrl(ctx, rec.id), { text: 'More hooks', changeType: 'SECTION_CONTENT', targetSection: 's1-react-hooks-tutorial' }).expect(400);

    const r = (await review(ctx)).recommendations;
    expect(r[0].originality).toMatchObject({ applies: true, policy: 'require_ack', requireCheck: true });
    expect(r[0].originality.checks).toHaveLength(3);
    expect(r[0].originality.checks[0].id).not.toBe(first.id); // newest first
    expect(r[1].originality).toMatchObject({ applies: false, checks: [] });
  });

  it('never compares against or reveals another tenant’s pages', async () => {
    const alice = await seed('alice');
    const rec = (await analyzed(alice)).recommendations[0];
    const bob = await seed('bob');
    await otherPage(bob, 'bob-copy', COPIED);
    const check = (await alice.post(checkUrl(alice, rec.id), { text: COPIED, changeType: 'META_DESCRIPTION' }).expect(201)).body;
    expect(check.assessment).toBe('NO_MATCHES');
    expect(JSON.stringify(check)).not.toContain('bob');
    await bob.post(checkUrl(alice, rec.id), { text: COPIED }).expect(404);
    await bob.post(`${API(bob.project.id)}/${bob.opp.id}/recommendations/${rec.id}/originality`, { text: COPIED }).expect(404);
    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: alice.project.organizationId, role: 'VIEWER' } });
    await viewer.post(checkUrl(alice, rec.id), { text: COPIED }).expect(403);
  });
});
