-- AlterTable
ALTER TABLE "OptimizationProposal" ADD COLUMN     "originalityAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "originalityAcknowledgedById" TEXT,
ADD COLUMN     "originalityCheckId" TEXT,
ADD COLUMN     "originalityStatus" TEXT;

-- CreateTable
CREATE TABLE "OriginalityCheck" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "recommendationReviewId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageVersionId" TEXT NOT NULL,
    "draftId" TEXT,
    "changeType" TEXT NOT NULL,
    "targetSection" TEXT,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "assessment" TEXT,
    "overlapRatio" DOUBLE PRECISION,
    "matches" JSONB NOT NULL,
    "corpusPages" INTEGER,
    "checker" TEXT NOT NULL,
    "checkerVersion" TEXT NOT NULL,
    "limitations" JSONB NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "checkedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OriginalityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OriginalityCheck_recommendationReviewId_textHash_createdAt_idx" ON "OriginalityCheck"("recommendationReviewId", "textHash", "createdAt");

-- CreateIndex
CREATE INDEX "OriginalityCheck_organizationId_projectId_opportunityId_idx" ON "OriginalityCheck"("organizationId", "projectId", "opportunityId");

-- AddForeignKey
ALTER TABLE "OptimizationProposal" ADD CONSTRAINT "OptimizationProposal_originalityCheckId_fkey" FOREIGN KEY ("originalityCheckId") REFERENCES "OriginalityCheck"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OriginalityCheck" ADD CONSTRAINT "OriginalityCheck_recommendationReviewId_fkey" FOREIGN KEY ("recommendationReviewId") REFERENCES "RecommendationReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
