import { Queue } from 'bullmq';
import { redis } from '../config/redis.js';

export const AI_ANALYSIS_QUEUE = 'ai-analysis';

export interface AIAnalysisJobData {
  runId: string;
}

let queue: Queue<AIAnalysisJobData> | null = null;
export function aiAnalysisQueue() {
  queue ??= new Queue<AIAnalysisJobData>(AI_ANALYSIS_QUEUE, {
    connection: redis(),
    // Retries only reach the queue for transient provider errors; invalid output / refusals are UnrecoverableError.
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } },
  });
  return queue;
}

/** BullMQ job id = run id, so a run is never enqueued twice. */
export async function enqueueAIAnalysis(runId: string) {
  await aiAnalysisQueue().add('analyze', { runId }, { jobId: runId });
}

export async function closeAIAnalysisQueue() {
  await queue?.close();
  queue = null;
}
