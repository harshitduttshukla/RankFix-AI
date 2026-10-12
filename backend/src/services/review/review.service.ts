import { Prisma, type OpportunityStatus, type ProposalChangeType } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { aiAnalysisRepository } from '../../repositories/ai-analysis.repository.js';
import { opportunityRepository } from '../../repositories/opportunity.repository.js';
import { reviewRepository, type DraftRow, type ProposalRow } from '../../repositories/review.repository.js';
import type { Db } from '../../repositories/types.js';
import type { RejectRecommendationInput } from '../../schemas/review.schema.js';
import type { TenantContext } from '../../types/tenant.js';
import { AppError, notFound } from '../../utils/errors.js';
import { buildAIContext } from '../ai/ai-context.builder.js';
import { AIError } from '../ai/ai.errors.js';
import { aiProvider } from '../ai/ai.provider.js';
import type { Recommendation, StoredRecommendation } from '../ai/ai.schemas.js';
import { checkDraft, draftLimits, draftTarget, normalizeDraft, type DraftTarget } from '../ai/drafts.js';
import { opportunityAnalysisService } from '../ai/opportunity-analysis.service.js';
import { originalityService, originalityTarget, type OriginalityDecision } from '../originality/originality.service.js';
import { opportunityService } from '../optimization/opportunity.service.js';
import { buildProposalValues, defaultChangeType, ProposalInputError, proposalHash, type VersionValues } from './proposal-builder.js';
import { evaluateStaleness, type EvidenceSnapshot, type StaleReason } from './staleness.js';

/*
 * Phase 6: deterministic human review. AI recommends, a human decides, the system records the decision.
 * Nothing here calls the AI (except an explicit re-analysis request) or touches the live website.
 */

type Tx = Prisma.TransactionClient;

/** Opportunity states in which humans may review / propose. */
const REVIEWABLE: OpportunityStatus[] = ['DETECTED', 'REVIEWED', 'PROPOSED'];

export type AnalysisState = 'NO_ANALYSIS' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STALE';

export interface RecommendationEdit {
  recommendation?: string;
  rationale?: string;
  type?: Recommendation['type'];
  targetSection?: string | null;
}

export interface ProposalInput {
  proposedValue: string;
  changeType?: ProposalChangeType;
  targetSection?: string | null;
  /** The originality check whose significant matches the reviewer acknowledged (must be the check of this exact text). */
  acknowledgeOriginalityCheckId?: string;
}

export interface OriginalityCheckInput {
  text: string;
  changeType?: ProposalChangeType;
  targetSection?: string | null;
  draftId?: string | null;
}

/** Proposal columns and audit metadata for an originality decision. */
function originalityFields(d: OriginalityDecision, userId: string) {
  return {
    data: {
      originalityCheckId: d.check?.id ?? null,
      originalityStatus: d.status,
      originalityAcknowledgedById: d.acknowledged ? userId : null,
      originalityAcknowledgedAt: d.acknowledged ? new Date() : null,
    },
    meta: { checkId: d.check?.id ?? null, status: d.status, assessment: d.check?.assessment ?? null, acknowledged: d.acknowledged },
  };
}

const audit = (tenant: TenantContext, websiteId: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>, db: Db) =>
  auditRepository.record(
    {
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      actorUserId: tenant.userId,
      action,
      entityType,
      entityId,
      metadata: { websiteId, ...metadata } as Prisma.InputJsonValue,
    },
    db,
  );

const effective = (r: { original: unknown; edited: unknown }) => (r.edited ?? r.original) as StoredRecommendation;

/** A draft a reviewer may start from. revision 0 / id null is the analysis's own draft. */
export interface OfferedDraft {
  id: string | null;
  revision: number;
  value: string;
  note: string | null;
  createdAt: Date | null;
}

/**
 * Drafts that still match the recommendation as it stands, oldest first. The analysis draft only while the
 * reviewer hasn't changed the type or target; regenerated drafts only if made after the last edit.
 */
function offeredDrafts(r: { original: unknown; edited: unknown; editedAt: Date | null; createdAt: Date; drafts: DraftRow[] }): OfferedDraft[] {
  const original = r.original as StoredRecommendation;
  const rec = effective(r);
  const out: OfferedDraft[] = [];
  if (original.suggestedValue && rec.type === original.type && rec.targetSection === original.targetSection) {
    out.push({ id: null, revision: 0, value: original.suggestedValue, note: null, createdAt: r.createdAt });
  }
  for (const d of r.drafts) if (!r.editedAt || d.createdAt > r.editedAt) out.push({ id: d.id, revision: d.revision, value: d.value, note: d.note, createdAt: d.createdAt });
  return out;
}

/** The change type a draft target is applied as. */
const DRAFT_CHANGE: Record<DraftTarget, ProposalChangeType> = { TITLE: 'TITLE', META_DESCRIPTION: 'META_DESCRIPTION', H1: 'H1', SECTION_HEADING: 'SECTION_HEADING', INTRODUCTION: 'SECTION_CONTENT' };

/**
 * Where a proposal's value came from, decided on the server: an unedited offered draft (AI_DRAFT), a value that
 * differs from the draft or from an edited recommendation (HUMAN_EDITED), or neither (AI_RECOMMENDATION).
 */
function proposalSource(
  review: Parameters<typeof offeredDrafts>[0],
  change: { changeType: ProposalChangeType; targetSection: string | null; proposedValue: string },
  values: VersionValues,
) {
  const rec = effective(review);
  const drafts = offeredDrafts(review);
  const target = draftTarget(rec, values);
  if (target && DRAFT_CHANGE[target] === change.changeType && (change.targetSection ?? null) === (DRAFT_CHANGE[target].startsWith('SECTION') ? rec.targetSection : null)) {
    const match = [...drafts].reverse().find((d) => normalizeDraft(target, d.value) === change.proposedValue);
    if (match) return { source: 'AI_DRAFT' as const, draftId: match.id, draftRevision: match.revision };
  }
  return { source: review.edited || drafts.length ? ('HUMAN_EDITED' as const) : ('AI_RECOMMENDATION' as const), draftId: null, draftRevision: null };
}

/** Rethrows conflicts from unique indexes as a 409 the client can show. */
function conflict(err: unknown, message: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new AppError('CONFLICT', message);
  throw err;
}

async function loadOpportunity(tenant: TenantContext, opportunityId: string) {
  const opp = await opportunityRepository.find(tenant, opportunityId);
  if (!opp) throw notFound('Opportunity');
  return opp;
}

/**
 * Staleness of the latest analysis. Once detected it is persisted (sticky) and audited once, so the
 * UI never presents a stale analysis as current even if the page later reverts.
 */
async function analysisStaleness(
  tenant: TenantContext,
  opp: { id: string; websiteId: string; pageId: string; clicks: number; impressions: number; position: number },
  analysis: { id: string; pageVersionId: string | null; evidenceSnapshot: unknown; staleAt: Date | null; staleReason: string | null },
): Promise<StaleReason | null> {
  if (analysis.staleAt) return analysis.staleReason as StaleReason;
  const page = await prisma.contentPage.findFirst({ where: { id: opp.pageId, organizationId: tenant.organizationId, projectId: tenant.projectId }, select: { currentVersionId: true } });
  const reason = evaluateStaleness({
    analysisPageVersionId: analysis.pageVersionId,
    currentPageVersionId: page?.currentVersionId ?? null,
    snapshot: (analysis.evidenceSnapshot as EvidenceSnapshot | null) ?? null,
    opportunity: opp,
  });
  if (!reason) return null;
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.opportunityAnalysis.updateMany({ where: { id: analysis.id, staleAt: null }, data: { staleAt: new Date(), staleReason: reason } });
    if (count) {
      await auditRepository.record(
        {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          actorUserId: null,
          action: 'analysis.marked_stale',
          entityType: 'OpportunityAnalysis',
          entityId: analysis.id,
          metadata: { websiteId: opp.websiteId, opportunityId: opp.id, reason, analyzedVersionId: analysis.pageVersionId, currentVersionId: page?.currentVersionId ?? null },
        },
        tx,
      );
    }
  });
  return reason;
}

/** Everything an approval needs, checked in one place. Throws the specific reason it is not allowed. */
async function approvalContext(tenant: TenantContext, opportunityId: string, reviewId: string) {
  const opp = await loadOpportunity(tenant, opportunityId);
  if (!REVIEWABLE.includes(opp.status)) throw new AppError('INVALID_STATE_TRANSITION', `Opportunity is ${opp.status}; it can no longer be reviewed`);
  const review = await reviewRepository.findReview(tenant, opp.id, reviewId);
  if (!review) throw notFound('Recommendation');
  const analysis = await reviewRepository.latestAnalysis(tenant, opp.id);
  if (!analysis || analysis.id !== review.analysisId) {
    throw new AppError('ANALYSIS_STALE', 'This recommendation belongs to an older analysis. Review the latest analysis instead.');
  }
  const stale = await analysisStaleness(tenant, opp, analysis);
  if (stale) throw new AppError('ANALYSIS_STALE', `Re-analysis required: ${stale === 'PAGE_VERSION_CHANGED' ? 'the page changed since it was analyzed' : 'the Search Console evidence changed since it was analyzed'}`);
  if (!analysis.pageVersionId) throw new AppError('ANALYSIS_STALE', 'The analysis had no crawled page content; crawl the page and re-analyze');
  const version = await reviewRepository.findVersion(tenant, opp.pageId, analysis.pageVersionId);
  if (!version) throw new AppError('ANALYSIS_STALE', 'The analyzed page version no longer exists; re-analyze');
  const values: VersionValues = { title: version.title, metaDescription: version.metaDescription, h1: version.h1, sections: version.pageSections };
  return { opp, review, analysis, version, values };
}

function toProposalValues(input: ProposalInput, rec: Pick<Recommendation, 'type' | 'targetSection'>, values: VersionValues) {
  const changeType = input.changeType ?? defaultChangeType(rec);
  if (!changeType) throw new AppError('VALIDATION_ERROR', 'Choose a change type (and target section) for this recommendation');
  try {
    return buildProposalValues({ changeType, targetSection: input.targetSection ?? rec.targetSection, proposedValue: input.proposedValue }, values);
  } catch (err) {
    if (err instanceof ProposalInputError) throw new AppError('VALIDATION_ERROR', err.message);
    throw err;
  }
}

/** DETECTED → REVIEWED on the first human action; audited once. */
async function markReviewed(tx: Tx, tenant: TenantContext, opp: { id: string; websiteId: string }) {
  const { count } = await tx.optimizationOpportunity.updateMany({
    where: { id: opp.id, organizationId: tenant.organizationId, projectId: tenant.projectId, status: 'DETECTED' },
    data: { status: 'REVIEWED', reviewedById: tenant.userId, reviewedAt: new Date() },
  });
  if (count) await audit(tenant, opp.websiteId, 'opportunity.reviewed', 'OptimizationOpportunity', opp.id, { opportunityId: opp.id, from: 'DETECTED', to: 'REVIEWED' }, tx);
}

function proposalView(p: ProposalRow, currentVersionId: string | null) {
  return { ...p, pageVersionNo: p.pageVersion.versionNo, pageVersion: undefined, matchesCurrentPageVersion: p.pageVersionId === currentVersionId };
}

export const reviewService = {
  async getReview(tenant: TenantContext, opportunityId: string) {
    const detail = await opportunityService.get(tenant, opportunityId);
    const opp = await loadOpportunity(tenant, opportunityId);
    const [page, latestRun, analysis] = await Promise.all([
      reviewRepository.currentPageVersion(tenant, opp.pageId),
      aiAnalysisRepository.latestRun(tenant, opp.id),
      reviewRepository.latestAnalysis(tenant, opp.id),
    ]);
    if (!page) throw notFound('Opportunity');

    const staleReason = analysis ? await analysisStaleness(tenant, opp, analysis) : null;
    let state: AnalysisState = 'NO_ANALYSIS';
    if (latestRun?.status === 'QUEUED' || latestRun?.status === 'RUNNING') state = latestRun.status;
    else if (latestRun?.status === 'FAILED' && (!analysis || latestRun.createdAt > analysis.createdAt)) state = 'FAILED';
    else if (analysis) state = staleReason ? 'STALE' : 'COMPLETED';

    const reviews = analysis ? await reviewRepository.ensureReviews(analysis) : [];
    const checks = await originalityService.recentByReview(tenant, reviews.map((r) => r.id));
    const originalityCfg = originalityService.config();
    const analyzedVersion = analysis?.pageVersionId ? await reviewRepository.findVersion(tenant, opp.pageId, analysis.pageVersionId) : null;
    const values: VersionValues | null = analyzedVersion
      ? { title: analyzedVersion.title, metaDescription: analyzedVersion.metaDescription, h1: analyzedVersion.h1, sections: analyzedVersion.pageSections }
      : null;

    const limits = draftLimits();
    return {
      opportunity: detail,
      page: {
        id: page.id,
        url: page.url,
        status: page.status,
        lastCrawledAt: page.lastCrawledAt,
        currentVersionId: page.currentVersionId,
        currentVersion: page.currentVersion,
      },
      analysisState: state,
      latestRun,
      analysis: analysis && {
        id: analysis.id,
        createdAt: analysis.createdAt,
        model: analysis.model,
        promptVersion: analysis.promptVersion,
        contextVersion: analysis.contextVersion,
        pageVersionId: analysis.pageVersionId,
        pageVersionNo: analyzedVersion?.versionNo ?? null,
        stale: Boolean(staleReason),
        staleReason,
        ...(analysis.analysis as object),
        caveats: (analysis.recommendations as { caveats?: string[] })?.caveats ?? [],
      },
      recommendations: reviews.map((r) => {
        const rec = effective(r);
        const changeType = defaultChangeType(rec);
        const drafts = offeredDrafts(r);
        const draftable = values ? draftTarget(rec, values) !== null : false;
        let currentValue: string | null = null;
        if (values && changeType) {
          try {
            currentValue = buildPreview(changeType, rec.targetSection, values);
          } catch {
            currentValue = null;
          }
        }
        return {
          id: r.id,
          index: r.recommendationIndex,
          status: r.status,
          original: r.original,
          edited: r.edited,
          effective: rec,
          editedById: r.editedById,
          editedAt: r.editedAt,
          reviewedById: r.reviewedById,
          reviewedAt: r.reviewedAt,
          rejectionReason: r.rejectionReason,
          rejectionNote: r.rejectionNote,
          suggestedChangeType: changeType,
          currentValue,
          draftable,
          draft: drafts.at(-1) ?? null,
          drafts,
          draftIssues: (r.original as StoredRecommendation).draftIssues ?? [],
          draftRegenerationsLeft: Math.max(0, limits.maxRegenerations - r.drafts.length),
          originality: {
            applies: Boolean(values && changeType && originalityTarget(changeType, rec.targetSection, values)),
            policy: originalityCfg.checker === 'none' ? ('off' as const) : originalityCfg.policy,
            requireCheck: originalityCfg.requireCheck,
            checks: checks.get(r.id) ?? [],
          },
          proposals: r.proposals.map((p) => proposalView(p, page.currentVersionId)),
        };
      }),
    };
  },

  async editRecommendation(tenant: TenantContext, opportunityId: string, reviewId: string, edit: RecommendationEdit) {
    const opp = await loadOpportunity(tenant, opportunityId);
    if (!REVIEWABLE.includes(opp.status)) throw new AppError('INVALID_STATE_TRANSITION', `Opportunity is ${opp.status}; it can no longer be reviewed`);
    const review = await reviewRepository.findReview(tenant, opp.id, reviewId);
    if (!review) throw notFound('Recommendation');
    const before = effective(review);
    const after: StoredRecommendation = {
      ...before,
      ...(edit.recommendation !== undefined ? { recommendation: edit.recommendation } : {}),
      ...(edit.rationale !== undefined ? { rationale: edit.rationale } : {}),
      ...(edit.type !== undefined ? { type: edit.type } : {}),
      ...(edit.targetSection !== undefined ? { targetSection: edit.targetSection } : {}),
    };
    // A draft written for another field must not follow the recommendation to a new type or target.
    if (after.type !== before.type || after.targetSection !== before.targetSection) {
      after.suggestedValue = null;
      delete after.draftIssues;
    }
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.recommendationReview.updateMany({
        where: { id: review.id, status: { in: ['PENDING', 'EDITED'] } },
        data: { edited: after as unknown as Prisma.InputJsonValue, editedById: tenant.userId, editedAt: new Date(), status: 'EDITED' },
      });
      if (!count) throw new AppError('INVALID_STATE_TRANSITION', 'Only pending recommendations can be edited');
      await markReviewed(tx, tenant, opp);
      await audit(tenant, opp.websiteId, 'recommendation.edited', 'RecommendationReview', review.id, {
        opportunityId: opp.id,
        recommendationId: review.id,
        analysisId: review.analysisId,
        from: { recommendation: before.recommendation, type: before.type, targetSection: before.targetSection },
        to: { recommendation: after.recommendation, type: after.type, targetSection: after.targetSection },
      }, tx);
    });
    return reviewService.getReview(tenant, opportunityId);
  },

  /** Approves a recommendation and creates its concrete proposal (awaiting proposal approval), atomically. */
  async approveRecommendation(tenant: TenantContext, opportunityId: string, reviewId: string, input: ProposalInput) {
    const { opp, review, analysis, version, values } = await approvalContext(tenant, opportunityId, reviewId);
    if (review.status === 'APPROVED' || review.status === 'REJECTED') throw new AppError('INVALID_STATE_TRANSITION', `Recommendation is already ${review.status.toLowerCase()}`);
    const rec = effective(review);
    const change = toProposalValues(input, rec, values);
    const origin = proposalSource(review, change, values);
    const subject = { opp, review, version, values: { sections: values.sections } };
    const originality = originalityFields(
      await originalityService.enforce(tenant, subject, { changeType: change.changeType, targetSection: change.targetSection, text: change.proposedValue, draftId: origin.draftId }, input.acknowledgeOriginalityCheckId),
      tenant.userId,
    );
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.recommendationReview.updateMany({
          where: { id: review.id, status: { in: ['PENDING', 'EDITED'] } },
          data: { status: 'APPROVED', reviewedById: tenant.userId, reviewedAt: new Date() },
        });
        if (!count) throw new AppError('INVALID_STATE_TRANSITION', 'Recommendation was already reviewed');
        const proposal = await tx.optimizationProposal.create({
          data: {
            organizationId: tenant.organizationId,
            projectId: tenant.projectId,
            websiteId: opp.websiteId,
            opportunityId: opp.id,
            recommendationReviewId: review.id,
            analysisId: analysis.id,
            pageId: opp.pageId,
            pageVersionId: version.id,
            ...change,
            source: origin.source,
            draftId: origin.draftId,
            ...originality.data,
            createdById: tenant.userId,
          },
        });
        await markReviewed(tx, tenant, opp);
        const meta = { opportunityId: opp.id, recommendationId: review.id, analysisId: analysis.id, from: review.status, to: 'APPROVED' };
        await audit(tenant, opp.websiteId, 'recommendation.approved', 'RecommendationReview', review.id, meta, tx);
        await audit(tenant, opp.websiteId, 'proposal.created', 'OptimizationProposal', proposal.id, {
          opportunityId: opp.id,
          recommendationId: review.id,
          proposalId: proposal.id,
          changeType: change.changeType,
          pageVersionId: version.id,
          revision: 1,
          source: origin.source,
          draftId: origin.draftId,
          draftRevision: origin.draftRevision,
          originality: originality.meta,
        }, tx);
        if (originality.meta.acknowledged) {
          await audit(tenant, opp.websiteId, 'originality.acknowledged', 'OptimizationProposal', proposal.id, { opportunityId: opp.id, recommendationId: review.id, proposalId: proposal.id, checkId: originality.meta.checkId, stage: 'proposal.created' }, tx);
        }
      });
    } catch (err) {
      conflict(err, 'Recommendation was already approved');
    }
    return reviewService.getReview(tenant, opportunityId);
  },

  async rejectRecommendation(tenant: TenantContext, opportunityId: string, reviewId: string, input: RejectRecommendationInput) {
    const opp = await loadOpportunity(tenant, opportunityId);
    if (!REVIEWABLE.includes(opp.status)) throw new AppError('INVALID_STATE_TRANSITION', `Opportunity is ${opp.status}; it can no longer be reviewed`);
    const review = await reviewRepository.findReview(tenant, opp.id, reviewId);
    if (!review) throw notFound('Recommendation');
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.recommendationReview.updateMany({
        where: { id: review.id, status: { in: ['PENDING', 'EDITED'] } },
        data: {
          status: 'REJECTED',
          reviewedById: tenant.userId,
          reviewedAt: new Date(),
          rejectionReason: input.reason ?? 'OTHER',
          rejectionNote: input.note ?? null,
        },
      });
      if (!count) throw new AppError('INVALID_STATE_TRANSITION', 'Only pending recommendations can be rejected');
      await markReviewed(tx, tenant, opp);
      await audit(tenant, opp.websiteId, 'recommendation.rejected', 'RecommendationReview', review.id, {
        opportunityId: opp.id,
        recommendationId: review.id,
        from: review.status,
        to: 'REJECTED',
        reason: input.reason ?? 'OTHER',
        note: input.note ?? null,
      }, tx);
    });
    return reviewService.getReview(tenant, opportunityId);
  },

  /** New proposal revision for an approved recommendation; the live one (if any) is SUPERSEDED, never edited. */
  async createProposal(tenant: TenantContext, opportunityId: string, reviewId: string, input: ProposalInput) {
    const { opp, review, analysis, version, values } = await approvalContext(tenant, opportunityId, reviewId);
    if (review.status !== 'APPROVED') throw new AppError('INVALID_STATE_TRANSITION', 'Only approved recommendations can have proposals');
    const change = toProposalValues(input, effective(review), values);
    const origin = proposalSource(review, change, values);
    const originality = originalityFields(
      await originalityService.enforce(tenant, { opp, review, version, values: { sections: values.sections } }, { changeType: change.changeType, targetSection: change.targetSection, text: change.proposedValue, draftId: origin.draftId }, input.acknowledgeOriginalityCheckId),
      tenant.userId,
    );
    try {
      await prisma.$transaction(async (tx) => {
        const previous = await tx.optimizationProposal.findFirst({ where: { recommendationReviewId: review.id }, orderBy: { revision: 'desc' } });
        if (previous && (previous.status === 'AWAITING_APPROVAL' || previous.status === 'APPROVED')) {
          const { count } = await tx.optimizationProposal.updateMany({ where: { id: previous.id, status: previous.status }, data: { status: 'SUPERSEDED' } });
          if (!count) throw new AppError('CONFLICT', 'The proposal changed concurrently; reload and retry');
          await audit(tenant, opp.websiteId, 'proposal.superseded', 'OptimizationProposal', previous.id, { opportunityId: opp.id, proposalId: previous.id, from: previous.status, to: 'SUPERSEDED' }, tx);
        }
        const revision = (previous?.revision ?? 0) + 1;
        const proposal = await tx.optimizationProposal.create({
          data: {
            organizationId: tenant.organizationId,
            projectId: tenant.projectId,
            websiteId: opp.websiteId,
            opportunityId: opp.id,
            recommendationReviewId: review.id,
            analysisId: analysis.id,
            pageId: opp.pageId,
            pageVersionId: version.id,
            ...change,
            source: origin.source,
            draftId: origin.draftId,
            ...originality.data,
            revision,
            supersedesId: previous?.id ?? null,
            createdById: tenant.userId,
          },
        });
        await audit(tenant, opp.websiteId, 'proposal.created', 'OptimizationProposal', proposal.id, {
          opportunityId: opp.id,
          recommendationId: review.id,
          proposalId: proposal.id,
          changeType: change.changeType,
          pageVersionId: version.id,
          revision,
          supersedes: previous?.id ?? null,
          source: origin.source,
          draftId: origin.draftId,
          draftRevision: origin.draftRevision,
          originality: originality.meta,
        }, tx);
        if (originality.meta.acknowledged) {
          await audit(tenant, opp.websiteId, 'originality.acknowledged', 'OptimizationProposal', proposal.id, { opportunityId: opp.id, recommendationId: review.id, proposalId: proposal.id, checkId: originality.meta.checkId, stage: 'proposal.created' }, tx);
        }
      });
    } catch (err) {
      conflict(err, 'Another proposal was created concurrently; reload and retry');
    }
    return reviewService.getReview(tenant, opportunityId);
  },

  /**
   * Final human approval of a concrete proposal. Re-checks that the analysis is current and that the page's
   * live version is still the analyzed version, then freezes the change with a hash for Phase 7.
   */
  async approveProposal(tenant: TenantContext, opportunityId: string, proposalId: string, comment?: string, acknowledgeOriginalityCheckId?: string) {
    const opp = await loadOpportunity(tenant, opportunityId);
    const proposal = await reviewRepository.findProposal(tenant, opp.id, proposalId);
    if (!proposal) throw notFound('Proposal');
    if (proposal.status !== 'AWAITING_APPROVAL') throw new AppError('INVALID_STATE_TRANSITION', `Proposal is ${proposal.status}`);
    if (proposal.review.status !== 'APPROVED') throw new AppError('INVALID_STATE_TRANSITION', 'The recommendation is not approved');
    const ctx = await approvalContext(tenant, opportunityId, proposal.recommendationReviewId); // analysis current, not stale, opportunity reviewable
    const page = await reviewRepository.currentPageVersion(tenant, opp.pageId);
    if (page?.currentVersionId !== proposal.pageVersionId) {
      throw new AppError('STALE_CONTENT_VERSION', 'The page changed since this proposal was created; re-analyze before approving');
    }
    // Final gate on the exact text being approved. An acknowledgment made at creation carries over only while the
    // same check result is still the current one for this text.
    const originality = await originalityService.enforce(
      tenant,
      { opp, review: { id: proposal.recommendationReviewId }, version: ctx.version, values: { sections: ctx.values.sections } },
      { changeType: proposal.changeType, targetSection: proposal.targetSection, text: proposal.proposedValue, draftId: proposal.draftId },
      acknowledgeOriginalityCheckId ?? (proposal.originalityAcknowledgedAt ? proposal.originalityCheckId : null),
    );
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.optimizationProposal.updateMany({
          where: { id: proposal.id, status: 'AWAITING_APPROVAL' },
          data: { status: 'APPROVED', approvedById: tenant.userId, approvedAt: new Date(), approvedAgainstVersionId: page.currentVersionId },
        });
        if (!count) throw new AppError('INVALID_STATE_TRANSITION', 'Proposal was already decided');
        await tx.optimizationApproval.create({
          data: { organizationId: tenant.organizationId, proposalId: proposal.id, decidedById: tenant.userId, decision: 'APPROVED', comment: comment ?? null, proposalHash: proposalHash(proposal) },
        });
        const moved = await tx.optimizationOpportunity.updateMany({
          where: { id: opp.id, organizationId: tenant.organizationId, projectId: tenant.projectId, status: { in: ['DETECTED', 'REVIEWED'] } },
          data: { status: 'PROPOSED' },
        });
        await audit(tenant, opp.websiteId, 'proposal.approved', 'OptimizationProposal', proposal.id, {
          opportunityId: opp.id,
          recommendationId: proposal.recommendationReviewId,
          proposalId: proposal.id,
          pageVersionId: proposal.pageVersionId,
          from: 'AWAITING_APPROVAL',
          to: 'APPROVED',
          opportunityStatus: moved.count ? { from: opp.status, to: 'PROPOSED' } : null,
          originality: originalityFields(originality, tenant.userId).meta,
        }, tx);
        if (originality.acknowledged) {
          await audit(tenant, opp.websiteId, 'originality.acknowledged', 'OptimizationProposal', proposal.id, { opportunityId: opp.id, proposalId: proposal.id, checkId: originality.check?.id ?? null, stage: 'proposal.approved' }, tx);
        }
      });
    } catch (err) {
      conflict(err, 'Proposal was already decided');
    }
    return reviewService.getReview(tenant, opportunityId);
  },

  async rejectProposal(tenant: TenantContext, opportunityId: string, proposalId: string, reason?: string) {
    const opp = await loadOpportunity(tenant, opportunityId);
    const proposal = await reviewRepository.findProposal(tenant, opp.id, proposalId);
    if (!proposal) throw notFound('Proposal');
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.optimizationProposal.updateMany({
          where: { id: proposal.id, status: 'AWAITING_APPROVAL' },
          data: { status: 'REJECTED', rejectedById: tenant.userId, rejectedAt: new Date(), rejectionReason: reason ?? null },
        });
        if (!count) throw new AppError('INVALID_STATE_TRANSITION', `Proposal is ${proposal.status}`);
        await tx.optimizationApproval.create({
          data: { organizationId: tenant.organizationId, proposalId: proposal.id, decidedById: tenant.userId, decision: 'REJECTED', comment: reason ?? null, proposalHash: proposalHash(proposal) },
        });
        await audit(tenant, opp.websiteId, 'proposal.rejected', 'OptimizationProposal', proposal.id, {
          opportunityId: opp.id,
          proposalId: proposal.id,
          from: 'AWAITING_APPROVAL',
          to: 'REJECTED',
          reason: reason ?? null,
        }, tx);
      });
    } catch (err) {
      conflict(err, 'Proposal was already decided');
    }
    return reviewService.getReview(tenant, opportunityId);
  },

  /** REVIEWED|PROPOSED → REJECTED. Unapplied proposals are superseded so Phase 7 never picks them up. */
  async rejectOpportunity(tenant: TenantContext, opportunityId: string, reason?: string) {
    const opp = await loadOpportunity(tenant, opportunityId);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.optimizationOpportunity.updateMany({
        where: { id: opp.id, organizationId: tenant.organizationId, projectId: tenant.projectId, status: { in: ['REVIEWED', 'PROPOSED'] } },
        data: { status: 'REJECTED', rejectionReason: reason ?? null, reviewedById: tenant.userId, reviewedAt: new Date() },
      });
      if (!count) throw new AppError('INVALID_STATE_TRANSITION', `Only reviewed or proposed opportunities can be rejected (status is ${opp.status})`);
      const superseded = await tx.optimizationProposal.updateMany({ where: { opportunityId: opp.id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'SUPERSEDED' } });
      await audit(tenant, opp.websiteId, 'opportunity.rejected', 'OptimizationOpportunity', opp.id, {
        opportunityId: opp.id,
        from: opp.status,
        to: 'REJECTED',
        reason: reason ?? null,
        proposalsSuperseded: superseded.count,
      }, tx);
    });
    return opportunityService.get(tenant, opportunityId);
  },

  /**
   * Reviewer-requested new AI draft for one recommendation. Same preconditions as approval (current, non-stale
   * analysis bound to the page's live version). Only a draft that passes every check is stored, as a new revision;
   * the analysis draft, earlier drafts, human edits and proposals are never changed.
   */
  async regenerateDraft(tenant: TenantContext, opportunityId: string, reviewId: string) {
    const { opp, review, analysis, version, values } = await approvalContext(tenant, opportunityId, reviewId);
    if (review.status === 'REJECTED') throw new AppError('INVALID_STATE_TRANSITION', 'Rejected recommendations cannot get new drafts');
    const rec = effective(review);
    if (!draftTarget(rec, values)) throw new AppError('VALIDATION_ERROR', `${rec.type} recommendations${rec.targetSection ? ` for "${rec.targetSection}"` : ''} do not support AI drafts`);
    const limits = draftLimits();
    if (review.drafts.length >= limits.maxRegenerations) throw new AppError('RATE_LIMITED', `At most ${limits.maxRegenerations} new drafts can be requested per recommendation`);

    let provider;
    try {
      provider = aiProvider();
    } catch (err) {
      if (err instanceof AIError && err.code === 'AI_NOT_CONFIGURED') throw new AppError('AI_NOT_CONFIGURED', 'AI drafting is not configured on this server');
      throw err;
    }
    const context = await buildAIContext(tenant, opp.id);
    // The draft must be grounded in exactly the version the analysis (and any proposal) is bound to.
    if (context.page.content?.versionId !== version.id) throw new AppError('ANALYSIS_STALE', 'The page changed since it was analyzed; re-analyze before drafting');

    const failed = async (code: string, message: string, issues: string[] = []) => {
      await audit(tenant, opp.websiteId, 'recommendation.draft_failed', 'RecommendationReview', review.id, { opportunityId: opp.id, recommendationId: review.id, analysisId: analysis.id, code, issues: issues.slice(0, 5) }, prisma);
      return message;
    };
    let result;
    try {
      result = await provider.generateDraft(context, rec as Recommendation, offeredDrafts(review).map((d) => d.value));
    } catch (err) {
      const e = err instanceof AIError ? err : new AIError('PROVIDER_ERROR', 'Unexpected AI provider failure', false);
      const msg = await failed(e.code, e.message);
      throw new AppError(e.code === 'AI_REFUSED' ? 'AI_REFUSED' : 'AI_OUTPUT_INVALID', `Could not generate a draft: ${msg}`);
    }
    const raw = result.output.suggestedValue;
    if (raw == null || !raw.trim()) {
      throw new AppError('AI_REFUSED', await failed('NO_DRAFT', `The AI did not write a draft${result.output.note ? `: ${result.output.note}` : ''}`));
    }
    const issues = checkDraft(context, rec, raw, limits);
    const target = draftTarget(rec, values)!;
    const value = normalizeDraft(target, raw);
    if (offeredDrafts(review).some((d) => normalizeDraft(target, d.value) === value)) issues.push('draft repeats an earlier draft');
    if (issues.length) {
      throw new AppError('AI_OUTPUT_INVALID', await failed('DRAFT_INVALID', `The new draft failed validation and was discarded: ${issues.slice(0, 3).join('; ')}`, issues), { issues });
    }

    try {
      await prisma.$transaction(async (tx) => {
        const revision = (review.drafts.at(-1)?.revision ?? 0) + 1;
        const draft = await tx.recommendationDraft.create({
          data: {
            organizationId: tenant.organizationId,
            projectId: tenant.projectId,
            websiteId: opp.websiteId,
            opportunityId: opp.id,
            recommendationReviewId: review.id,
            analysisId: analysis.id,
            pageVersionId: version.id,
            revision,
            value,
            note: result.output.note.trim().slice(0, 400) || null,
            provider: provider.name,
            model: result.model,
            promptVersion: result.promptVersion,
            requestedById: tenant.userId,
            latencyMs: result.latencyMs,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        });
        await markReviewed(tx, tenant, opp);
        await audit(tenant, opp.websiteId, 'recommendation.draft_generated', 'RecommendationReview', review.id, {
          opportunityId: opp.id,
          recommendationId: review.id,
          analysisId: analysis.id,
          draftId: draft.id,
          draftRevision: revision,
          pageVersionId: version.id,
          model: result.model,
          promptVersion: result.promptVersion,
        }, tx);
      });
    } catch (err) {
      conflict(err, 'Another draft was requested concurrently; reload and retry');
    }
    return reviewService.getReview(tenant, opportunityId);
  },

  /**
   * Reviewer-requested originality check of any text for a checkable field of this recommendation (the draft, or
   * the reviewer's edit). Always runs a new check ("run again"); results are stored, never overwritten.
   */
  async checkOriginality(tenant: TenantContext, opportunityId: string, reviewId: string, input: OriginalityCheckInput) {
    const { opp, review, version, values } = await approvalContext(tenant, opportunityId, reviewId);
    const rec = effective(review);
    const changeType = input.changeType ?? defaultChangeType(rec);
    if (!changeType) throw new AppError('VALIDATION_ERROR', 'Choose a change type (and target section) to check');
    const targetSection = input.targetSection !== undefined ? input.targetSection : rec.targetSection;
    if (!originalityTarget(changeType, targetSection, values)) {
      throw new AppError('VALIDATION_ERROR', 'Originality checks apply to the title, meta description, H1, section headings and the intro text');
    }
    if (input.draftId && !review.drafts.some((d) => d.id === input.draftId)) throw notFound('Draft');
    return originalityService.run(tenant, { opp, review, version, values: { sections: values.sections } }, { changeType, targetSection, text: input.text, draftId: input.draftId ?? null });
  },

  /** Explicit re-analysis through the existing Phase 5 pipeline (new run; history is kept). */
  async reanalyze(tenant: TenantContext, opportunityId: string) {
    const opp = await loadOpportunity(tenant, opportunityId);
    const analysis = await reviewRepository.latestAnalysis(tenant, opp.id);
    const stale = analysis ? await analysisStaleness(tenant, opp, analysis) : null;
    const { run, created } = await opportunityAnalysisService.request(tenant, opp.id);
    if (created) {
      await audit(tenant, opp.websiteId, 'analysis.reanalysis_requested', 'OptimizationOpportunity', opp.id, {
        opportunityId: opp.id,
        runId: run.id,
        previousAnalysisId: analysis?.id ?? null,
        reason: stale ?? (analysis ? 'USER_REQUESTED' : 'NO_ANALYSIS'),
      }, prisma);
    }
    return run;
  },
};

/** Current value preview for the review UI (same rule as proposals, but tolerant of missing sections). */
function buildPreview(changeType: ProposalChangeType, targetSection: string | null, v: VersionValues): string | null {
  if (changeType === 'TITLE') return v.title;
  if (changeType === 'META_DESCRIPTION') return v.metaDescription;
  if (changeType === 'H1') return v.h1;
  const s = v.sections.find((x) => x.sectionKey === targetSection);
  if (!s) return null;
  return changeType === 'SECTION_HEADING' ? s.heading : s.text;
}

/** For Phase 7: an approved proposal may only be applied while the page is still on the version it was approved against. */
export async function proposalMatchesCurrentPage(scope: Pick<TenantContext, 'organizationId' | 'projectId'>, proposalId: string) {
  const p = await prisma.optimizationProposal.findFirst({
    where: { id: proposalId, organizationId: scope.organizationId, projectId: scope.projectId },
    select: { pageId: true, pageVersionId: true, status: true },
  });
  if (!p) return null;
  const page = await prisma.contentPage.findFirst({ where: { id: p.pageId, organizationId: scope.organizationId, projectId: scope.projectId }, select: { currentVersionId: true } });
  return { status: p.status, pageVersionId: p.pageVersionId, currentVersionId: page?.currentVersionId ?? null, matches: page?.currentVersionId === p.pageVersionId };
}
