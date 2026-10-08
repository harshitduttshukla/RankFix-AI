import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import type { TenantContext } from '../types/tenant.js';
import type { Db } from './types.js';

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;
const t = (scope: Scope) => ({ organizationId: scope.organizationId, projectId: scope.projectId });

export const proposalSelect = {
  id: true,
  recommendationReviewId: true,
  analysisId: true,
  pageId: true,
  pageVersionId: true,
  changeType: true,
  targetSection: true,
  currentValue: true,
  proposedValue: true,
  source: true,
  revision: true,
  supersedesId: true,
  status: true,
  createdById: true,
  approvedById: true,
  approvedAt: true,
  approvedAgainstVersionId: true,
  rejectedById: true,
  rejectedAt: true,
  rejectionReason: true,
  createdAt: true,
  pageVersion: { select: { versionNo: true } },
} as const;

export type ProposalRow = Prisma.OptimizationProposalGetPayload<{ select: typeof proposalSelect }>;

export const reviewRepository = {
  /** The analysis an action may target: the newest one for the opportunity. */
  latestAnalysis(scope: Scope, opportunityId: string, db: Db = prisma) {
    return db.opportunityAnalysis.findFirst({ where: { ...t(scope), opportunityId }, orderBy: { createdAt: 'desc' } });
  },

  /** One review row per recommendation, created on first access; concurrent callers are absorbed by the unique key. */
  async ensureReviews(analysis: { id: string; organizationId: string; projectId: string; websiteId: string; opportunityId: string; recommendations: unknown }) {
    const recs = ((analysis.recommendations as { recommendations?: unknown[] })?.recommendations ?? []) as Prisma.InputJsonValue[];
    if (recs.length) {
      await prisma.recommendationReview.createMany({
        data: recs.map((original, recommendationIndex) => ({
          organizationId: analysis.organizationId,
          projectId: analysis.projectId,
          websiteId: analysis.websiteId,
          opportunityId: analysis.opportunityId,
          analysisId: analysis.id,
          recommendationIndex,
          original,
        })),
        skipDuplicates: true,
      });
    }
    return prisma.recommendationReview.findMany({
      where: { analysisId: analysis.id, organizationId: analysis.organizationId, projectId: analysis.projectId },
      orderBy: { recommendationIndex: 'asc' },
      include: { proposals: { select: proposalSelect, orderBy: { revision: 'asc' } } },
    });
  },

  findReview(scope: Scope, opportunityId: string, reviewId: string, db: Db = prisma) {
    return db.recommendationReview.findFirst({ where: { id: reviewId, opportunityId, ...t(scope) } });
  },

  findProposal(scope: Scope, opportunityId: string, proposalId: string, db: Db = prisma) {
    return db.optimizationProposal.findFirst({ where: { id: proposalId, opportunityId, ...t(scope) }, include: { review: true } });
  },

  /** The analyzed version, reached through the opportunity's own page so it can't belong to another page or tenant. */
  findVersion(scope: Scope, pageId: string, versionId: string, db: Db = prisma) {
    return db.contentPageVersion.findFirst({
      where: { id: versionId, pageId, organizationId: scope.organizationId, page: { projectId: scope.projectId } },
      select: {
        id: true,
        versionNo: true,
        title: true,
        metaDescription: true,
        h1: true,
        pageSections: { orderBy: { order: 'asc' }, select: { sectionKey: true, heading: true, text: true } },
      },
    });
  },

  currentPageVersion(scope: Scope, pageId: string, db: Db = prisma) {
    return db.contentPage.findFirst({
      where: { id: pageId, ...t(scope) },
      select: {
        id: true,
        url: true,
        status: true,
        lastCrawledAt: true,
        currentVersionId: true,
        currentVersionNo: true,
        currentVersion: {
          select: {
            id: true,
            versionNo: true,
            title: true,
            metaDescription: true,
            canonicalUrl: true,
            h1: true,
            headings: true,
            wordCount: true,
            createdAt: true,
            pageSections: { orderBy: { order: 'asc' }, select: { sectionKey: true, heading: true, level: true, wordCount: true } },
          },
        },
      },
    });
  },
};
