-- CreateEnum
CREATE TYPE "ApplyMethod" AS ENUM ('MANUAL');

-- AlterEnum
ALTER TYPE "RunStatus" ADD VALUE 'AWAITING_CHANGE';

-- AlterTable
ALTER TABLE "OptimizationRun" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastCrawlJobId" TEXT,
ADD COLUMN     "method" "ApplyMethod" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationDetail" JSONB,
ADD COLUMN     "verificationError" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OptimizationMeasurement" ADD COLUMN     "daysWithData" INTEGER,
ADD COLUMN     "pageUrl" TEXT,
ADD COLUMN     "propertyId" TEXT,
ALTER COLUMN "position" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "OptimizationRun_status_idx" ON "OptimizationRun"("status");

