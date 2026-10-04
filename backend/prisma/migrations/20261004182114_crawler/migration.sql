/*
  Warnings:

  - You are about to drop the column `internalLinks` on the `ContentPageVersion` table. All the data in the column will be lost.
  - Added the required column `sections` to the `ContentPageVersion` table without a default value. This is not possible if the table is not empty.
  - Added the required column `seoMeta` to the `ContentPageVersion` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('HTTP_CHEERIO', 'PLAYWRIGHT');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrawlOutcome" AS ENUM ('CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PageStatus" ADD VALUE 'REDIRECTED';
ALTER TYPE "PageStatus" ADD VALUE 'ERROR';

-- AlterTable
ALTER TABLE "ContentPage" ADD COLUMN     "lastCrawlJobId" TEXT,
ADD COLUMN     "noindex" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "redirectedTo" TEXT;

-- AlterTable
ALTER TABLE "ContentPageVersion" DROP COLUMN "internalLinks",
ADD COLUMN     "canonicalUrl" TEXT,
ADD COLUMN     "crawlJobId" TEXT,
ADD COLUMN     "crawlerVersion" TEXT,
ADD COLUMN     "extractionMethod" "ExtractionMethod",
ADD COLUMN     "httpStatus" INTEGER,
ADD COLUMN     "invalidJsonLd" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "rawHtml" TEXT,
ADD COLUMN     "renderedHtml" TEXT,
ADD COLUMN     "robotsMeta" TEXT,
ADD COLUMN     "sections" JSONB NOT NULL,
ADD COLUMN     "seoMeta" JSONB NOT NULL;

-- CreateTable
CREATE TABLE "PageSection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "heading" TEXT,
    "level" INTEGER NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "blocks" JSONB NOT NULL,

    CONSTRAINT "PageSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "anchorText" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL,
    "inContent" BOOLEAN NOT NULL,
    "rel" TEXT[],
    "nofollow" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PageLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageImage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "src" TEXT NOT NULL,
    "alt" TEXT,
    "title" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "inContent" BOOLEAN NOT NULL,

    CONSTRAINT "PageImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageStructuredData" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "types" TEXT[],
    "data" JSONB NOT NULL,

    CONSTRAINT "PageStructuredData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "requestedById" TEXT,
    "status" "CrawlStatus" NOT NULL DEFAULT 'PENDING',
    "discoveryMethod" TEXT,
    "sitemapUrls" JSONB,
    "robotsFound" BOOLEAN,
    "config" JSONB NOT NULL,
    "pagesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "pagesSucceeded" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "pagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "pagesCreated" INTEGER NOT NULL DEFAULT 0,
    "pagesUpdated" INTEGER NOT NULL DEFAULT 0,
    "pagesUnchanged" INTEGER NOT NULL DEFAULT 0,
    "renderedPages" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlPageResult" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crawlJobId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "outcome" "CrawlOutcome" NOT NULL,
    "httpStatus" INTEGER,
    "extractionMethod" "ExtractionMethod",
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "pageId" TEXT,
    "versionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlPageResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageSection_organizationId_idx" ON "PageSection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PageSection_versionId_order_key" ON "PageSection"("versionId", "order");

-- CreateIndex
CREATE INDEX "PageLink_versionId_idx" ON "PageLink"("versionId");

-- CreateIndex
CREATE INDEX "PageLink_organizationId_targetUrl_idx" ON "PageLink"("organizationId", "targetUrl");

-- CreateIndex
CREATE INDEX "PageImage_versionId_idx" ON "PageImage"("versionId");

-- CreateIndex
CREATE INDEX "PageStructuredData_versionId_idx" ON "PageStructuredData"("versionId");

-- CreateIndex
CREATE INDEX "CrawlJob_organizationId_projectId_websiteId_createdAt_idx" ON "CrawlJob"("organizationId", "projectId", "websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "CrawlJob_status_idx" ON "CrawlJob"("status");

-- CreateIndex
CREATE INDEX "CrawlPageResult_crawlJobId_outcome_idx" ON "CrawlPageResult"("crawlJobId", "outcome");

-- AddForeignKey
ALTER TABLE "PageSection" ADD CONSTRAINT "PageSection_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ContentPageVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ContentPageVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageImage" ADD CONSTRAINT "PageImage_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ContentPageVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageStructuredData" ADD CONSTRAINT "PageStructuredData_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ContentPageVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlJob" ADD CONSTRAINT "CrawlJob_websiteId_projectId_organizationId_fkey" FOREIGN KEY ("websiteId", "projectId", "organizationId") REFERENCES "Website"("id", "projectId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlPageResult" ADD CONSTRAINT "CrawlPageResult_crawlJobId_fkey" FOREIGN KEY ("crawlJobId") REFERENCES "CrawlJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
