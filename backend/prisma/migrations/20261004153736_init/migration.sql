-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "UpdateProviderType" AS ENUM ('SITE_UPDATE_API');

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('ACTIVE', 'GONE', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "VersionSource" AS ENUM ('CRAWL', 'OPTIMIZATION', 'PRE_UPDATE');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'QUEUED', 'RUNNING', 'FAILED');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('DETECTED', 'ANALYZING', 'PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED', 'MEASURING', 'COMPLETED', 'REJECTED', 'FAILED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('LOW_CTR_HIGH_IMPRESSIONS', 'STRIKING_DISTANCE', 'DECLINING_CLICKS', 'DECLINING_CTR', 'WEAK_QUERY_COVERAGE');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED', 'SUPERSEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('APPLYING', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "MeasurementKind" AS ENUM ('BASELINE', 'POST');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Website" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "blogPathPrefix" TEXT,
    "updateProvider" "UpdateProviderType" NOT NULL DEFAULT 'SITE_UPDATE_API',
    "updateEndpointUrl" TEXT,
    "updateSecretEnc" TEXT,
    "lastCrawledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Website_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "externalId" TEXT,
    "httpStatus" INTEGER NOT NULL,
    "status" "PageStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentVersionId" TEXT,
    "currentVersionNo" INTEGER NOT NULL DEFAULT 0,
    "lastCrawledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPageVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "source" "VersionSource" NOT NULL,
    "title" TEXT,
    "metaDescription" TEXT,
    "h1" TEXT,
    "headings" JSONB NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "internalLinks" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByRunId" TEXT,

    CONSTRAINT "ContentPageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GSCConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "connectedById" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GSCConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GSCProperty" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "permissionLevel" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncedDate" DATE,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GSCProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GSCSearchAnalytics" (
    "id" BIGSERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GSCSearchAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationOpportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "pageTitle" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "opportunityType" "OpportunityType" NOT NULL,
    "signals" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "gscMetrics" JSONB NOT NULL,
    "queries" JSONB NOT NULL,
    "analysis" JSONB,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'DETECTED',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptimizationOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationProposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "baseVersionNo" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "affectedSections" JSONB NOT NULL,
    "beforeContent" JSONB NOT NULL,
    "afterContent" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "editedById" TEXT,
    "aiModel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptimizationProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationApproval" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "comment" TEXT,
    "proposalHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "previousVersionId" TEXT NOT NULL,
    "newVersionId" TEXT,
    "status" "RunStatus" NOT NULL,
    "error" TEXT,
    "appliedById" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationMeasurement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "MeasurementKind" NOT NULL,
    "windowStart" DATE NOT NULL,
    "windowEnd" DATE NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "queries" JSONB NOT NULL,
    "dataComplete" BOOLEAN NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "Project_organizationId_idx" ON "Project"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_id_organizationId_key" ON "Project"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Website_organizationId_projectId_idx" ON "Website"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Website_projectId_hostname_key" ON "Website"("projectId", "hostname");

-- CreateIndex
CREATE UNIQUE INDEX "Website_id_projectId_organizationId_key" ON "Website"("id", "projectId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPage_currentVersionId_key" ON "ContentPage"("currentVersionId");

-- CreateIndex
CREATE INDEX "ContentPage_organizationId_projectId_idx" ON "ContentPage"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPage_websiteId_url_key" ON "ContentPage"("websiteId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPage_id_websiteId_projectId_organizationId_key" ON "ContentPage"("id", "websiteId", "projectId", "organizationId");

-- CreateIndex
CREATE INDEX "ContentPageVersion_organizationId_idx" ON "ContentPageVersion"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPageVersion_pageId_versionNo_key" ON "ContentPageVersion"("pageId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "GSCConnection_projectId_key" ON "GSCConnection"("projectId");

-- CreateIndex
CREATE INDEX "GSCConnection_organizationId_idx" ON "GSCConnection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "GSCProperty_websiteId_key" ON "GSCProperty"("websiteId");

-- CreateIndex
CREATE INDEX "GSCProperty_organizationId_projectId_idx" ON "GSCProperty"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "GSCSearchAnalytics_organizationId_projectId_page_date_idx" ON "GSCSearchAnalytics"("organizationId", "projectId", "page", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GSCSearchAnalytics_propertyId_date_page_query_key" ON "GSCSearchAnalytics"("propertyId", "date", "page", "query");

-- CreateIndex
CREATE INDEX "OptimizationOpportunity_organizationId_projectId_status_idx" ON "OptimizationOpportunity"("organizationId", "projectId", "status");

-- CreateIndex
CREATE INDEX "OptimizationOpportunity_pageId_idx" ON "OptimizationOpportunity"("pageId");

-- CreateIndex
CREATE INDEX "OptimizationProposal_organizationId_projectId_status_idx" ON "OptimizationProposal"("organizationId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationApproval_proposalId_key" ON "OptimizationApproval"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationRun_proposalId_key" ON "OptimizationRun"("proposalId");

-- CreateIndex
CREATE INDEX "OptimizationRun_organizationId_projectId_idx" ON "OptimizationRun"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationMeasurement_runId_kind_key" ON "OptimizationMeasurement"("runId", "kind");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_projectId_createdAt_idx" ON "AuditLog"("organizationId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Website" ADD CONSTRAINT "Website_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_websiteId_projectId_organizationId_fkey" FOREIGN KEY ("websiteId", "projectId", "organizationId") REFERENCES "Website"("id", "projectId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ContentPageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPageVersion" ADD CONSTRAINT "ContentPageVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ContentPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GSCConnection" ADD CONSTRAINT "GSCConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GSCConnection" ADD CONSTRAINT "GSCConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GSCProperty" ADD CONSTRAINT "GSCProperty_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GSCConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GSCProperty" ADD CONSTRAINT "GSCProperty_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GSCSearchAnalytics" ADD CONSTRAINT "GSCSearchAnalytics_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "GSCProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationOpportunity" ADD CONSTRAINT "OptimizationOpportunity_pageId_websiteId_projectId_organiz_fkey" FOREIGN KEY ("pageId", "websiteId", "projectId", "organizationId") REFERENCES "ContentPage"("id", "websiteId", "projectId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationProposal" ADD CONSTRAINT "OptimizationProposal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "OptimizationOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationApproval" ADD CONSTRAINT "OptimizationApproval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "OptimizationProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationApproval" ADD CONSTRAINT "OptimizationApproval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationRun" ADD CONSTRAINT "OptimizationRun_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "OptimizationOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationRun" ADD CONSTRAINT "OptimizationRun_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "OptimizationProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationMeasurement" ADD CONSTRAINT "OptimizationMeasurement_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OptimizationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
