-- OptimizationProposal was an unused placeholder (no rows, no writers) and is reshaped into a concrete,
-- page-version-bound change. OptimizationApproval is reused unchanged for proposal decisions.

-- CreateEnum
CREATE TYPE "ProposalChangeType" AS ENUM ('TITLE', 'META_DESCRIPTION', 'H1', 'SECTION_HEADING', 'SECTION_CONTENT');

-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('AI_RECOMMENDATION', 'HUMAN_EDITED');

-- CreateEnum
CREATE TYPE "RecommendationReviewStatus" AS ENUM ('PENDING', 'EDITED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RecommendationRejectionReason" AS ENUM ('NOT_RELEVANT', 'INCORRECT', 'ALREADY_ADDRESSED', 'NOT_WORTH_CHANGING', 'OTHER');

-- AlterTable
ALTER TABLE "OpportunityAnalysis" ADD COLUMN     "evidenceSnapshot" JSONB,
ADD COLUMN     "staleAt" TIMESTAMP(3),
ADD COLUMN     "staleReason" TEXT;

-- AlterTable
ALTER TABLE "OptimizationOpportunity" ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "OptimizationProposal" DROP COLUMN "affectedSections",
DROP COLUMN "afterContent",
DROP COLUMN "aiModel",
DROP COLUMN "baseVersionId",
DROP COLUMN "baseVersionNo",
DROP COLUMN "beforeContent",
DROP COLUMN "changes",
DROP COLUMN "confidence",
DROP COLUMN "editedById",
DROP COLUMN "evidence",
DROP COLUMN "reason",
DROP COLUMN "summary",
ADD COLUMN     "analysisId" TEXT NOT NULL,
ADD COLUMN     "approvedAgainstVersionId" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "changeType" "ProposalChangeType" NOT NULL,
ADD COLUMN     "createdById" TEXT NOT NULL,
ADD COLUMN     "currentValue" TEXT,
ADD COLUMN     "pageVersionId" TEXT NOT NULL,
ADD COLUMN     "proposedValue" TEXT NOT NULL,
ADD COLUMN     "recommendationReviewId" TEXT NOT NULL,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedById" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "source" "ProposalSource" NOT NULL,
ADD COLUMN     "supersedesId" TEXT,
ADD COLUMN     "targetSection" TEXT,
ADD COLUMN     "websiteId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "RecommendationReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "recommendationIndex" INTEGER NOT NULL,
    "original" JSONB NOT NULL,
    "edited" JSONB,
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3),
    "status" "RecommendationReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" "RecommendationRejectionReason",
    "rejectionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendationReview_organizationId_projectId_opportunityId_idx" ON "RecommendationReview"("organizationId", "projectId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationReview_analysisId_recommendationIndex_key" ON "RecommendationReview"("analysisId", "recommendationIndex");

-- CreateIndex
CREATE INDEX "OptimizationProposal_opportunityId_idx" ON "OptimizationProposal"("opportunityId");

-- CreateIndex
CREATE INDEX "OptimizationProposal_recommendationReviewId_idx" ON "OptimizationProposal"("recommendationReviewId");

-- AddForeignKey
ALTER TABLE "OptimizationProposal" ADD CONSTRAINT "OptimizationProposal_recommendationReviewId_fkey" FOREIGN KEY ("recommendationReviewId") REFERENCES "RecommendationReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationProposal" ADD CONSTRAINT "OptimizationProposal_pageVersionId_fkey" FOREIGN KEY ("pageVersionId") REFERENCES "ContentPageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationReview" ADD CONSTRAINT "RecommendationReview_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "OptimizationOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationReview" ADD CONSTRAINT "RecommendationReview_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "OpportunityAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One live proposal (awaiting approval or approved) per reviewed recommendation; concurrent approvals collide here.
CREATE UNIQUE INDEX "OptimizationProposal_live_review_key"
  ON "OptimizationProposal"("recommendationReviewId")
  WHERE "status" IN ('AWAITING_APPROVAL', 'APPROVED');
