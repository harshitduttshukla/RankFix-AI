import { UnrecoverableError, Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { GSC_SYNC_QUEUE } from '../queues/gsc.queue.js';
import { markGscSyncFailed, runGscSync, SyncAbortedError, type GscSyncJobData } from '../services/gsc/gsc-sync.service.js';
import { logger } from '../utils/logger.js';

export function startGscWorker() {
  const worker = new Worker<GscSyncJobData>(
    GSC_SYNC_QUEUE,
    async (job) => {
      try {
        return await runGscSync(job.data, (pct) => job.updateProgress(pct));
      } catch (err) {
        // Revoked access or a deleted property won't fix itself: don't retry.
        if (err instanceof SyncAbortedError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    { connection: redis(), concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn({ jobId: job.id, attempt: job.attemptsMade, final, err: err.message }, 'GSC sync failed');
    if (final) void markGscSyncFailed(job.data, err.message);
  });
  worker.on('completed', (job, result) => logger.info({ jobId: job.id, result }, 'GSC sync completed'));
  return worker;
}
