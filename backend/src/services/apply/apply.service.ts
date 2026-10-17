import { Prisma, type OpportunityStatus, type RunStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { enqueueApplyVerification } from '../../queues/apply-verify.queue.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { crawlRepository } from '../../repositories/crawl.repository.js';
import { opportunityRepository } from '../../repositories/opportunity.repository.js';
import type { Db } from '../../repositories/types.js';
import type { TenantContext } from '../../types/tenant.js';
import { AppError, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { crawlerConfig } from '../crawler/config.js';
import { runCrawl, VERIFICATION_CRAWL, type RunOptions } from '../crawler/crawl-runner.js';
import { proposalHash } from '../review/proposal-builder.js';
import { baselineRow, baselineSummary, computeBaseline } from './baseline.js';
import { verifyChange, type VersionFields } from './verify.js';

/*
 * Phase 7a: apply-and-verify. The customer applies an approved change on their own site; RankFix AI never writes to
 * the website. "I've applied this" creates (or resumes) one OptimizationRun per proposal and queues a one-page
 * recrawl; a deterministic comparison of the live field decides the outcome.
 *
 * Run states: APPLYING (verification queued/running) → APPLIED | AWAITING_CHANGE | FAILED(verificationError).
 * AWAITING_CHANGE and FAILED (except ABANDONED) can be retried, which starts a new attempt.
 */

type Scope = { organizationId: string; projectId: string };

/** Opportunity states from which an approved proposal may be applied. */
const APPLY_OPEN: OpportunityStatus[] = ['PROPOSED', 'APPLYING', 'APPLIED'];
/** Opportunity states that may be abandoned (REVIEWED/PROPOSED without runs can also use the existing reject). */
const ABANDONABLE: OpportunityStatus[] = ['PROPOSED', 'APPLYING'];
const ACTIVE_RUN: RunStatus[] = ['APPLYING', 'AWAITING_CHANGE', 'FAILED'];

export type VerificationError =
  | 'CONTENT_CONFLICT'
  | 'TARGET_MISSING'
  | 'PAGE_GONE'
  | 'PAGE_REDIRECTED'
  | 'ROBOTS_DISALLOWED'
  | 'NOT_HTML'
  | 'FETCH_FAILED'
  | 'PROPOSAL_INTEGRITY'
  | 'INTERNAL'
  | 'ABANDONED';

export const isRetryable = (run: { status: RunStatus; verificationError: string | null }) =>
  run.status === 'AWAITING_CHANGE' || (run.status === 'FAILED' && run.verificationError !== 'ABANDONED' && run.verificationError !== 'PROPOSAL_INTEGRITY');

const versionSelect = {
  id: true,
  versionNo: true,
  title: true,
  metaDescription: true,
  h1: true,
  pageSections: { orderBy: { order: 'asc' }, select: { sectionKey: true, order: true, level: true, heading: true, text: true } },
} as const;

async function loadVersion(organizationId: string, pageId: string, versionId: string) {
  const v = await prisma.contentPageVersion.findFirst({ where: { id: versionId, pageId, organizationId }, select: versionSelect });
  return v && { id: v.id, versionNo: v.versionNo, fields: { title: v.title, metaDescription: v.metaDescription, h1: v.h1, sections: v.pageSections } satisfies VersionFields };
}

type ProposalForApply = Prisma.OptimizationProposalGetPayload<{ include: { approval: true; run: true; review: { select: { status: true } } } }>;

/** The approval record must still describe exactly this proposal (recomputed hash; nothing from the client is trusted). */
function integrityProblem(p: ProposalForApply): string | null {
  if (p.status !== 'APPROVED' && p.status !== 'APPLIED') return `proposal is ${p.status}`;
  if (p.review.status !== 'APPROVED') return 'the recommendation is no longer approved';
  const a = p.approval;
  if (!a || a.decision !== 'APPROVED') return 'no approval record';
  if (a.proposalHash !== proposalHash(p)) return 'the proposal changed after it was approved';
  if (!p.approvedAgainstVersionId || p.approvedAgainstVersionId !== p.pageVersionId) return 'the approval is not bound to the proposal’s page version';
  return null;
}

const audit = (scope: Scope, actorUserId: string | null, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>, db: Db = prisma) =>
  auditRepository.record({ ...scope, actorUserId, action, entityType, entityId, metadata: metadata as Prisma.InputJsonValue }, db);

/** Opportunity follows its runs: any unverified run → APPLYING; otherwise any verified run → APPLIED. */
async function syncOpportunity(tx: Prisma.TransactionClient, scope: Scope, opportunityId: string) {
  const runs = await tx.optimizationRun.findMany({ where: { ...scope, opportunityId }, select: { status: true, verificationError: true } });
  const pending = runs.some((r) => r.status === 'APPLYING' || isRetryable(r));
  const target: OpportunityStatus | null = pending ? 'APPLYING' : runs.some((r) => r.status === 'APPLIED') ? 'APPLIED' : null;
  if (!target) return null;
  const { count } = await tx.optimizationOpportunity.updateMany({ where: { id: opportunityId, ...scope, status: { in: APPLY_OPEN } }, data: { status: target } });
  return count ? target : null;
}

async function queue(runId: string, attempt: number) {
  try {
    await enqueueApplyVerification({ runId, attempt });
    return true;
  } catch (err) {
    // The run stays APPLYING: the worker's resume sweep or another "I've applied this" re-queues it.
    logger.error({ runId, attempt, err: (err as Error).message }, 'Could not queue apply verification');
    return false;
  }
}

export const applyService = {
  /**
   * "I've applied this". Idempotent: creates the run on first call, re-queues a run still APPLYING, starts a new
   * attempt for a retryable run, and returns an APPLIED run unchanged.
   */
  async markApplied(tenant: TenantContext, opportunityId: string, proposalId: string) {
    const scope = { organizationId: tenant.organizationId, projectId: tenant.projectId };
    const opp = await opportunityRepository.find(tenant, opportunityId);
    if (!opp) throw notFound('Opportunity');
    const proposal = await prisma.optimizationProposal.findFirst({
      where: { id: proposalId, opportunityId: opp.id, ...scope },
      include: { approval: true, run: true, review: { select: { status: true } } },
    });
    if (!proposal) throw notFound('Proposal');
    if (proposal.run?.status === 'APPLIED') return { run: proposal.run, queued: false };

    const problem = integrityProblem(proposal);
    if (problem) {
      throw new AppError(proposal.status === 'APPROVED' ? 'PROPOSAL_INTEGRITY' : 'INVALID_STATE_TRANSITION', `This proposal can't be applied: ${problem}`);
    }
    if (!APPLY_OPEN.includes(opp.status)) throw new AppError('INVALID_STATE_TRANSITION', `Opportunity is ${opp.status}; its proposals can no longer be applied`);
    if (proposal.run && !isRetryable(proposal.run) && proposal.run.status !== 'APPLYING') {
      throw new AppError('INVALID_STATE_TRANSITION', `Verification can't be restarted (${proposal.run.verificationError ?? proposal.run.status})`);
    }

    // Staleness: the page may have moved past the approved version only by carrying this very change (or not yet
    // changing the target field at all). Any other value in the target field means the approval is out of date.
    const page = await prisma.contentPage.findFirst({ where: { id: proposal.pageId, ...scope }, select: { currentVersionId: true, url: true, websiteId: true } });
    if (!page?.currentVersionId) throw new AppError('STALE_CONTENT_VERSION', 'The page has no crawled version; crawl it again');
    const approved = await loadVersion(scope.organizationId, proposal.pageId, proposal.pageVersionId);
    if (!approved) throw new AppError('STALE_CONTENT_VERSION', 'The approved page version no longer exists');
    // Checked when the workflow starts; a retry re-reads the live page, which is the point of retrying.
    if (!proposal.run && page.currentVersionId !== proposal.pageVersionId) {
      const current = await loadVersion(scope.organizationId, proposal.pageId, page.currentVersionId);
      const check = current && verifyChange(proposal, approved.fields, current.fields);
      if (!check || check.result === 'CONFLICT' || check.result === 'TARGET_MISSING') {
        throw new AppError('STALE_CONTENT_VERSION', 'The page changed since this proposal was approved, in the part this proposal edits. Abandon it and re-analyze the page.');
      }
    }

    if (!proposal.run) {
      const { baseline, limitation } = await computeBaseline(scope, page.websiteId, page.url);
      try {
        await prisma.$transaction(async (tx) => {
          const run = await tx.optimizationRun.create({
            data: {
              ...scope,
              opportunityId: opp.id,
              proposalId: proposal.id,
              pageId: proposal.pageId,
              previousVersionId: proposal.approvedAgainstVersionId!,
              status: 'APPLYING',
              method: 'MANUAL',
              appliedById: tenant.userId,
              verificationAttempts: 1,
            },
          });
          if (baseline) await tx.optimizationMeasurement.createMany({ data: [baselineRow(scope.organizationId, run.id, baseline)], skipDuplicates: true });
          await syncOpportunity(tx, scope, opp.id);
          await audit(scope, tenant.userId, 'proposal.marked_applied', 'OptimizationProposal', proposal.id, {
            websiteId: opp.websiteId,
            opportunityId: opp.id,
            proposalId: proposal.id,
            runId: run.id,
            method: 'MANUAL',
            changeType: proposal.changeType,
            approvedVersionId: proposal.approvedAgainstVersionId,
            attempt: 1,
            baseline: baselineSummary(baseline, limitation),
          }, tx);
        });
      } catch (err) {
        // A concurrent request created the run first (OptimizationRun.proposalId is unique): continue with it.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    } else if (isRetryable(proposal.run)) {
      const r = proposal.run;
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.optimizationRun.updateMany({
          where: { id: r.id, status: r.status, verificationAttempts: r.verificationAttempts },
          data: { status: 'APPLYING', verificationAttempts: { increment: 1 }, verificationError: null },
        });
        if (!count) return; // another request restarted it first
        await syncOpportunity(tx, scope, opp.id);
        await audit(scope, tenant.userId, 'proposal.marked_applied', 'OptimizationProposal', proposal.id, {
          websiteId: opp.websiteId,
          opportunityId: opp.id,
          proposalId: proposal.id,
          runId: r.id,
          attempt: r.verificationAttempts + 1,
          retryOf: { status: r.status, verificationError: r.verificationError },
        }, tx);
      });
    }

    const run = await prisma.optimizationRun.findFirstOrThrow({ where: { proposalId: proposal.id, ...scope } });
    const queued = run.status === 'APPLYING' ? await queue(run.id, run.verificationAttempts) : false;
    return { run, queued };
  },

  /**
   * Closes the unapplied remainder of an opportunity: live proposals are SUPERSEDED, unverified runs end as
   * FAILED/ABANDONED, and the opportunity becomes REJECTED (terminal, so detection may find it again later), or
   * APPLIED if one of its changes was already verified.
   */
  async abandon(tenant: TenantContext, opportunityId: string, reason?: string) {
    const scope = { organizationId: tenant.organizationId, projectId: tenant.projectId };
    const opp = await opportunityRepository.find(tenant, opportunityId);
    if (!opp) throw notFound('Opportunity');
    if (!ABANDONABLE.includes(opp.status)) throw new AppError('INVALID_STATE_TRANSITION', `Only proposed or applying opportunities can be abandoned (status is ${opp.status})`);
    await prisma.$transaction(async (tx) => {
      const proposals = await tx.optimizationProposal.updateMany({ where: { ...scope, opportunityId: opp.id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'SUPERSEDED' } });
      const runs = await tx.optimizationRun.updateMany({
        where: { ...scope, opportunityId: opp.id, status: { in: ACTIVE_RUN } },
        data: { status: 'FAILED', verificationError: 'ABANDONED' },
      });
      const applied = await tx.optimizationRun.count({ where: { ...scope, opportunityId: opp.id, status: 'APPLIED' } });
      const to: OpportunityStatus = applied ? 'APPLIED' : 'REJECTED';
      const { count } = await tx.optimizationOpportunity.updateMany({
        where: { id: opp.id, ...scope, status: { in: ABANDONABLE } },
        data: { status: to, ...(to === 'REJECTED' ? { rejectionReason: reason ?? 'Abandoned', reviewedById: tenant.userId, reviewedAt: new Date() } : {}) },
      });
      if (!count) throw new AppError('CONFLICT', 'The opportunity changed concurrently; reload and retry');
      await audit(scope, tenant.userId, 'opportunity.abandoned', 'OptimizationOpportunity', opp.id, {
        websiteId: opp.websiteId,
        opportunityId: opp.id,
        from: opp.status,
        to,
        reason: reason ?? null,
        proposalsSuperseded: proposals.count,
        runsClosed: runs.count,
      }, tx);
    });
  },
};

const ERROR_FOR_CRAWL_CODE: Record<string, VerificationError> = {
  HTTP_404: 'PAGE_GONE',
  HTTP_410: 'PAGE_GONE',
  REDIRECT_OUT_OF_SCOPE: 'PAGE_REDIRECTED',
  REDIRECTED: 'PAGE_REDIRECTED',
  DUPLICATE: 'PAGE_REDIRECTED',
  ROBOTS_DISALLOWED: 'ROBOTS_DISALLOWED',
  NOT_HTML: 'NOT_HTML',
};

/**
 * Worker entry point for one verification attempt. Acts only while the run is APPLYING on exactly this attempt, so
 * duplicate, late or out-of-order deliveries can't change a decided run. Every write is conditional on that.
 */
export async function runApplyVerification(runId: string, attempt: number, opts: RunOptions = {}) {
  const run = await prisma.optimizationRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== 'APPLYING' || run.verificationAttempts !== attempt) return { skipped: true as const };
  const scope = { organizationId: run.organizationId, projectId: run.projectId };
  const live = { id: run.id, status: 'APPLYING' as const, verificationAttempts: attempt };

  const proposal = await prisma.optimizationProposal.findFirst({ where: { id: run.proposalId, ...scope }, include: { approval: true, run: true, review: { select: { status: true } } } });
  const page = await prisma.contentPage.findFirst({ where: { id: run.pageId, ...scope }, select: { id: true, url: true, websiteId: true } });
  const problem = !proposal ? 'proposal missing' : integrityProblem(proposal);
  if (!proposal || !page || problem) {
    return finish(run, attempt, { status: 'FAILED', error: 'PROPOSAL_INTEGRITY', detail: { explanation: problem ?? 'page missing' } });
  }

  const cfg = crawlerConfig();
  const job = await crawlRepository.create(
    { ...scope, userId: run.appliedById },
    page.websiteId,
    { maxPages: 1, concurrency: 1, delayMs: 0, requestTimeoutMs: cfg.requestTimeoutMs, maxDurationMs: cfg.maxDurationMs, playwrightEnabled: cfg.playwrightEnabled, playwrightMaxPages: 1, userAgent: cfg.userAgent, singleUrl: page.url },
    prisma,
    VERIFICATION_CRAWL,
  );
  const started = await prisma.optimizationRun.updateMany({ where: live, data: { lastCrawlJobId: job.id } });
  if (!started.count) {
    await crawlRepository.transition(job.id, ['PENDING'], { status: 'CANCELLED', completedAt: new Date() });
    return { skipped: true as const };
  }
  await audit(scope, null, 'apply.verification_started', 'OptimizationRun', run.id, { opportunityId: run.opportunityId, proposalId: run.proposalId, runId: run.id, attempt, crawlJobId: job.id });

  const crawlStatus = await runCrawl(job.id, opts);
  const result = await prisma.crawlPageResult.findFirst({ where: { crawlJobId: job.id, organizationId: scope.organizationId, url: page.url }, orderBy: { createdAt: 'desc' } });
  const base = { crawlJobId: job.id, crawlStatus, httpStatus: result?.httpStatus ?? null };

  if (!result) return finish(run, attempt, { status: 'FAILED', error: 'FETCH_FAILED', detail: { ...base, explanation: 'the page was not fetched' } });
  if (result.outcome === 'FAILED' || result.outcome === 'SKIPPED') {
    const error = ERROR_FOR_CRAWL_CODE[result.errorCode ?? ''] ?? 'FETCH_FAILED';
    return finish(run, attempt, { status: 'FAILED', error, detail: { ...base, crawlError: result.errorCode, finalUrl: result.finalUrl } });
  }
  if (result.finalUrl || result.pageId !== page.id || !result.versionId) {
    return finish(run, attempt, { status: 'FAILED', error: 'PAGE_REDIRECTED', detail: { ...base, finalUrl: result.finalUrl } });
  }

  const [approved, current] = await Promise.all([
    loadVersion(scope.organizationId, page.id, proposal.pageVersionId),
    loadVersion(scope.organizationId, page.id, result.versionId),
  ]);
  if (!approved || !current) return finish(run, attempt, { status: 'FAILED', error: 'INTERNAL', detail: { ...base, explanation: 'page version missing' } });

  const v = verifyChange(proposal, approved.fields, current.fields);
  const detail = { ...base, result: v.result, liveVersionId: current.id, liveVersionNo: current.versionNo, liveSectionKey: v.liveSectionKey, explanation: v.reason ?? null };
  if (v.result === 'MATCH') return finish(run, attempt, { status: 'APPLIED', error: null, detail, newVersionId: current.id });
  if (v.result === 'UNCHANGED') return finish(run, attempt, { status: 'AWAITING_CHANGE', error: null, detail });
  return finish(run, attempt, { status: 'FAILED', error: v.result === 'CONFLICT' ? 'CONTENT_CONFLICT' : 'TARGET_MISSING', detail });
}

async function finish(
  run: { id: string; organizationId: string; projectId: string; opportunityId: string; proposalId: string },
  attempt: number,
  o: { status: 'APPLIED' | 'AWAITING_CHANGE' | 'FAILED'; error: VerificationError | null; detail: Record<string, unknown>; newVersionId?: string },
) {
  const scope = { organizationId: run.organizationId, projectId: run.projectId };
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    if (o.status === 'APPLIED') {
      const p = await tx.optimizationProposal.updateMany({ where: { id: run.proposalId, ...scope, status: 'APPROVED' }, data: { status: 'APPLIED' } });
      if (!p.count) o = { status: 'FAILED', error: 'PROPOSAL_INTEGRITY', detail: { ...o.detail, explanation: 'proposal is no longer approved' } };
    }
    const { count } = await tx.optimizationRun.updateMany({
      where: { id: run.id, status: 'APPLYING', verificationAttempts: attempt },
      data: {
        status: o.status,
        verificationError: o.error,
        verificationDetail: o.detail as Prisma.InputJsonValue,
        lastCheckedAt: now,
        ...(o.status === 'APPLIED' ? { verifiedAt: now, appliedAt: now, newVersionId: o.newVersionId ?? null } : {}),
      },
    });
    if (!count) {
      // Decided or restarted meanwhile (abandon, newer attempt): leave everything as it is.
      if (o.status === 'APPLIED') throw new AppError('CONFLICT', 'Run changed during verification');
      return { skipped: true as const };
    }
    const opportunityStatus = await syncOpportunity(tx, scope, run.opportunityId);
    const action = o.status === 'APPLIED' ? 'apply.verified' : 'apply.verification_failed';
    await audit(scope, null, action, 'OptimizationRun', run.id, {
      ...o.detail,
      opportunityId: run.opportunityId,
      proposalId: run.proposalId,
      runId: run.id,
      attempt,
      status: o.status,
      reason: o.status === 'AWAITING_CHANGE' ? 'CHANGE_NOT_FOUND' : o.error,
      opportunityStatus,
    }, tx);
    return { skipped: false as const, status: o.status, error: o.error };
  });
}

/** Worker crash on an attempt: record it so the user can retry (never treated as applied). */
export async function markVerificationCrashed(runId: string, attempt: number, message: string) {
  const run = await prisma.optimizationRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== 'APPLYING' || run.verificationAttempts !== attempt) return;
  await finish(run, attempt, { status: 'FAILED', error: 'INTERNAL', detail: { explanation: message.slice(0, 300) } });
}

/** Runs left APPLYING (lost enqueue, worker restart) are queued again for their current attempt. */
export async function resumeApplyingRuns(olderThan = new Date(Date.now() - 2 * 60_000)) {
  const runs = await prisma.optimizationRun.findMany({ where: { status: 'APPLYING', updatedAt: { lt: olderThan } }, select: { id: true, verificationAttempts: true }, take: 500 });
  for (const r of runs) await queue(r.id, r.verificationAttempts);
  return runs.length;
}

/** Review-page view of a proposal's run. */
export function applyView(
  proposal: { status: string },
  opportunityStatus: OpportunityStatus,
  run: { id: string; status: RunStatus; verificationError: string | null; verificationDetail: unknown; verificationAttempts: number; lastCheckedAt: Date | null; verifiedAt: Date | null; newVersionId: string | null; previousVersionId: string; createdAt: Date; measurements: unknown[] } | null,
) {
  const eligible = proposal.status === 'APPROVED' && APPLY_OPEN.includes(opportunityStatus);
  return {
    canMarkApplied: eligible && !run,
    canRetry: eligible && Boolean(run && isRetryable(run)),
    run: run && { ...run, retryable: isRetryable(run), baseline: run.measurements[0] ?? null, measurements: undefined },
  };
}
