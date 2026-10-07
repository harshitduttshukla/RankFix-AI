import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { OPPORTUNITY_DETECT_QUEUE, type OpportunityDetectJobData } from '../queues/opportunity.queue.js';
import { opportunityRepository } from '../repositories/opportunity.repository.js';
import { markDetectionFailed, runDetection } from '../services/optimization/opportunity-detector.service.js';
import { logger } from '../utils/logger.js';

const STALE_AFTER_MS = 30 * 60_000;

export async function failInterruptedDetections() {
  const { count } = await opportunityRepository.failStaleRuns(new Date(Date.now() - STALE_AFTER_MS));
  if (count) logger.warn({ count }, 'Marked interrupted opportunity detections as FAILED');
}

export function startOpportunityWorker() {
  const worker = new Worker<OpportunityDetectJobData>(OPPORTUNITY_DETECT_QUEUE, (job) => runDetection(job.data.runId), {
    connection: redis(),
    concurrency: 2,
  });
  worker.on('failed', (job, err) => {
    logger.error({ runId: job?.data.runId, err: err.message }, 'Opportunity detection failed');
    if (job) void markDetectionFailed(job.data.runId, err.message);
  });
  return worker;
}
