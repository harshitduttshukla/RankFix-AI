-- CreateEnum
CREATE TYPE "AIRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "AIAnalysisRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "requestedById" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "status" "AIRunStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityAnalysis" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "pageVersionId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "analysis" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIAnalysisRun_organizationId_projectId_opportunityId_create_idx" ON "AIAnalysisRun"("organizationId", "projectId", "opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "AIAnalysisRun_status_idx" ON "AIAnalysisRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityAnalysis_runId_key" ON "OpportunityAnalysis"("runId");

-- CreateIndex
CREATE INDEX "OpportunityAnalysis_organizationId_projectId_opportunityId__idx" ON "OpportunityAnalysis"("organizationId", "projectId", "opportunityId", "createdAt");

-- AddForeignKey
ALTER TABLE "AIAnalysisRun" ADD CONSTRAINT "AIAnalysisRun_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "OptimizationOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityAnalysis" ADD CONSTRAINT "OpportunityAnalysis_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "OptimizationOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityAnalysis" ADD CONSTRAINT "OpportunityAnalysis_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

