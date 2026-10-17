import { Queue } from 'bullmq';
import { redis } from '../config/redis.js';

export const APPLY_VERIFY_QUEUE = 'apply-verify';

export interface ApplyVerifyJobData {
  runId: string;
  /** OptimizationRun.verificationAttempts this job was queued for; stale or duplicate deliveries are ignored. */
  attempt: number;
}

let queue: Queue<ApplyVerifyJobData> | null = null;
export function applyVerifyQueue() {
  queue ??= new Queue<ApplyVerifyJobData>(APPLY_VERIFY_QUEUE, {
    connection: redis(),
    // Fetch and content problems are recorded on the run (the user retries); a crash is recorded by the worker.
    // Finished jobs are removed so an interrupted attempt can be re-queued under the same id.
    defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
  });
  return queue;
}

/** Job id = run + attempt, so one attempt is never queued twice (BullMQ ignores a duplicate id). */
export async function enqueueApplyVerification(data: ApplyVerifyJobData) {
  await applyVerifyQueue().add('verify', data, { jobId: `${data.runId}-${data.attempt}` });
}

export async function closeApplyVerifyQueue() {
  await queue?.close();
  queue = null;
}
