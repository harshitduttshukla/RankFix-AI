-- At most one active (QUEUED/RUNNING) AI analysis run per opportunity. Not expressible in the Prisma schema.
CREATE UNIQUE INDEX "AIAnalysisRun_active_opportunity_key"
  ON "AIAnalysisRun"("opportunityId")
  WHERE "status" IN ('QUEUED', 'RUNNING');
