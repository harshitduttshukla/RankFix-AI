import { UnrecoverableError, Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { AI_ANALYSIS_QUEUE, type AIAnalysisJobData } from '../queues/ai-analysis.queue.js';
import { aiAnalysisRepository } from '../repositories/ai-analysis.repository.js';
import { markAIAnalysisFailed, runAIAnalysis } from '../services/ai/opportunity-analysis.service.js';
import { logger } from '../utils/logger.js';

const STALE_AFTER_MS = 45 * 60_000;

export async function failInterruptedAIAnalyses() {
  const { count } = await aiAnalysisRepository.failStaleRuns(new Date(Date.now() - STALE_AFTER_MS));
  if (count) logger.warn({ count }, 'Marked interrupted AI analyses as FAILED');
}

export function startAIAnalysisWorker() {
  const worker = new Worker<AIAnalysisJobData>(AI_ANALYSIS_QUEUE, (job) => runAIAnalysis(job.data.runId, job.attemptsMade + 1), {
    connection: redis(),
    concurrency: 2,
    lockDuration: 10 * 60_000, // two Claude calls can take minutes
  });
  worker.on('failed', (job, err) => {
    if (!job) return;
    const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn({ runId: job.data.runId, attempt: job.attemptsMade, final, err: err.message }, 'AI analysis job failed');
    // Non-retryable failures are already recorded with their specific code; this covers exhausted retries.
    if (final) void markAIAnalysisFailed(job.data.runId, 'RETRIES_EXHAUSTED', err.message);
  });
  return worker;
}
