-- CreateEnum
CREATE TYPE "DetectionStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DetectionTrigger" AS ENUM ('MANUAL', 'GSC_SYNC');

-- AlterEnum
ALTER TYPE "OpportunityStatus" ADD VALUE 'REVIEWED';


-- DropIndex
DROP INDEX "OptimizationOpportunity_organizationId_projectId_status_idx";

-- DropIndex
DROP INDEX "OptimizationOpportunity_pageId_idx";

-- Nothing wrote opportunities before Phase 4 (the table was a placeholder), so the old
-- shape is dropped rather than converted.
DELETE FROM "OptimizationOpportunity";

-- AlterTable
ALTER TABLE "OptimizationOpportunity" DROP COLUMN "gscMetrics",
DROP COLUMN "opportunityType",
DROP COLUMN "queries",
DROP COLUMN "signals",
ADD COLUMN     "clicks" INTEGER NOT NULL,
ADD COLUMN     "ctr" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "dateRangeEnd" DATE NOT NULL,
ADD COLUMN     "dateRangeStart" DATE NOT NULL,
ADD COLUMN     "detectionRunId" TEXT,
ADD COLUMN     "dismissReason" TEXT,
ADD COLUMN     "dismissedAt" TIMESTAMP(3),
ADD COLUMN     "dismissedById" TEXT,
ADD COLUMN     "impressions" INTEGER NOT NULL,
ADD COLUMN     "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "metrics" JSONB NOT NULL,
ADD COLUMN     "position" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "scoreBreakdown" JSONB NOT NULL,
ADD COLUMN     "topQueries" JSONB NOT NULL;

-- Replace OpportunityType (old values were never used)
DROP TYPE "OpportunityType";
CREATE TYPE "OpportunityType" AS ENUM ('LOW_CTR', 'PAGE_ONE_NEAR_TOP', 'HIGH_IMPRESSIONS_LOW_CLICKS', 'PERFORMANCE_DECLINE', 'CONTENT_COVERAGE_SIGNAL');
ALTER TABLE "OptimizationOpportunity" ADD COLUMN "type" "OpportunityType" NOT NULL;

-- CreateTable
CREATE TABLE "OpportunityDetectionRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestedById" TEXT,
    "trigger" "DetectionTrigger" NOT NULL,
    "status" "DetectionStatus" NOT NULL DEFAULT 'QUEUED',
    "config" JSONB,
    "websitesEvaluated" INTEGER NOT NULL DEFAULT 0,
    "pagesEvaluated" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "cleared" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityDetectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpportunityDetectionRun_organizationId_projectId_createdAt_idx" ON "OpportunityDetectionRun"("organizationId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "OptimizationOpportunity_organizationId_projectId_status_sco_idx" ON "OptimizationOpportunity"("organizationId", "projectId", "status", "score" DESC);

-- CreateIndex
CREATE INDEX "OptimizationOpportunity_pageId_type_idx" ON "OptimizationOpportunity"("pageId", "type");


-- Deduplication: at most one non-terminal opportunity per (page, type). Not expressible in the
-- Prisma schema. (Predicate lists terminal states so it doesn't reference the enum value added above
-- in the same transaction.)
CREATE UNIQUE INDEX "OptimizationOpportunity_open_page_type_key"
  ON "OptimizationOpportunity"("pageId", "type")
  WHERE "status" NOT IN ('COMPLETED', 'REJECTED', 'FAILED', 'DISMISSED');

-- Opportunity engine aggregates page-level total rows (query = '') per property and date window.
CREATE INDEX "GSCSearchAnalytics_page_totals_idx"
  ON "GSCSearchAnalytics"("propertyId", "date", "page")
  INCLUDE ("clicks", "impressions", "position")
  WHERE "query" = '';

-- Top queries for a batch of pages within a property/window.
CREATE INDEX "GSCSearchAnalytics_property_page_date_idx"
  ON "GSCSearchAnalytics"("propertyId", "page", "date")
  WHERE "query" <> '';
