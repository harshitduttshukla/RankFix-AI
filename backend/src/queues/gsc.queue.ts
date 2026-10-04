import { Queue } from 'bullmq';
import { redis } from '../config/redis.js';
import type { GscSyncJobData } from '../services/gsc/gsc-sync.service.js';

export const GSC_SYNC_QUEUE = 'gsc-sync';

let queue: Queue<GscSyncJobData> | null = null;
export function gscQueue() {
  queue ??= new Queue<GscSyncJobData>(GSC_SYNC_QUEUE, {
    connection: redis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
  return queue;
}

/** One pending/active sync per property: duplicate requests are collapsed. */
export async function enqueueGscSync(data: GscSyncJobData) {
  const job = await gscQueue().add('sync', data, { deduplication: { id: `gsc-sync:${data.propertyId}` } });
  return job.id!;
}

export async function closeGscQueue() {
  await queue?.close();
  queue = null;
}
