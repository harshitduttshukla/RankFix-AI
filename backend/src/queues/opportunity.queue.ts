import { Queue } from 'bullmq';
import { redis } from '../config/redis.js';

export const OPPORTUNITY_DETECT_QUEUE = 'opportunity-detect';

export interface OpportunityDetectJobData {
  runId: string;
}

let queue: Queue<OpportunityDetectJobData> | null = null;
export function opportunityQueue() {
  queue ??= new Queue<OpportunityDetectJobData>(OPPORTUNITY_DETECT_QUEUE, {
    connection: redis(),
    // A run is a status row; retrying would need a new QUEUED run, so failures are final and visible.
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } },
  });
  return queue;
}

/** BullMQ job id = run id, so a run can never be enqueued twice. */
export async function enqueueOpportunityDetection(runId: string) {
  await opportunityQueue().add('detect', { runId }, { jobId: runId });
}

export async function closeOpportunityQueue() {
  await queue?.close();
  queue = null;
}
