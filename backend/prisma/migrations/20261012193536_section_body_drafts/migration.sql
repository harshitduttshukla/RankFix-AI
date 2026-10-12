-- AlterTable
ALTER TABLE "RecommendationDraft" ADD COLUMN     "sectionKey" TEXT,
ADD COLUMN     "sourceTextHash" TEXT,
ADD COLUMN     "target" TEXT,
ADD COLUMN     "validation" JSONB;
