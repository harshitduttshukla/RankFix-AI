import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { APPLY_VERIFY_QUEUE, type ApplyVerifyJobData } from '../queues/apply-verify.queue.js';
import { markVerificationCrashed, resumeApplyingRuns, runApplyVerification } from '../services/apply/apply.service.js';
import { logger } from '../utils/logger.js';

const RESUME_EVERY_MS = 5 * 60_000;

/** Re-queues runs left APPLYING by a lost enqueue or a stopped worker. Safe to repeat: attempts are idempotent. */
export async function resumeInterruptedVerifications() {
  const count = await resumeApplyingRuns();
  if (count) logger.warn({ count }, 'Re-queued interrupted apply verifications');
}

export function startApplyVerifyWorker() {
  const worker = new Worker<ApplyVerifyJobData>(APPLY_VERIFY_QUEUE, (job) => runApplyVerification(job.data.runId, job.data.attempt), {
    connection: redis(),
    concurrency: 2,
    lockDuration: 120_000,
  });
  worker.on('failed', (job, err) => {
    logger.error({ runId: job?.data.runId, attempt: job?.data.attempt, err: err.message }, 'Apply verification crashed');
    if (job) void markVerificationCrashed(job.data.runId, job.data.attempt, err.message).catch(() => {});
  });
  const timer = setInterval(() => void resumeInterruptedVerifications().catch((err) => logger.error({ err }, 'Resume sweep failed')), RESUME_EVERY_MS);
  timer.unref();
  worker.on('closed', () => clearInterval(timer));
  return worker;
}
