-- AlterEnum
ALTER TYPE "ProposalSource" ADD VALUE 'AI_DRAFT';

-- AlterTable
ALTER TABLE "OptimizationProposal" ADD COLUMN     "draftId" TEXT;

-- CreateTable
CREATE TABLE "RecommendationDraft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "recommendationReviewId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "pageVersionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendationDraft_organizationId_projectId_opportunityId_idx" ON "RecommendationDraft"("organizationId", "projectId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationDraft_recommendationReviewId_revision_key" ON "RecommendationDraft"("recommendationReviewId", "revision");

-- AddForeignKey
ALTER TABLE "OptimizationProposal" ADD CONSTRAINT "OptimizationProposal_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "RecommendationDraft"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationDraft" ADD CONSTRAINT "RecommendationDraft_recommendationReviewId_fkey" FOREIGN KEY ("recommendationReviewId") REFERENCES "RecommendationReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
