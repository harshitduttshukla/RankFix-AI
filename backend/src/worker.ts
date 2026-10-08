import { prisma } from './config/database.js';
import { closeRedis } from './config/redis.js';
import { isAiConfigured } from './services/ai/ai.config.js';
import { logger } from './utils/logger.js';
import { failInterruptedCrawls, startCrawlWorker } from './workers/crawl.worker.js';
import { startGscWorker } from './workers/gsc.worker.js';
import { failInterruptedDetections, startOpportunityWorker } from './workers/opportunity.worker.js';
import { failInterruptedAIAnalyses, startAIAnalysisWorker } from './workers/ai-analysis.worker.js';

await failInterruptedCrawls();
await failInterruptedDetections();
await failInterruptedAIAnalyses();
const workers = [startGscWorker(), startCrawlWorker(), startOpportunityWorker(), startAIAnalysisWorker()];
logger.info('Workers started: gsc-sync, website-crawl, opportunity-detect, ai-analysis');
if (!isAiConfigured()) logger.warn('AI analysis is not configured (ANTHROPIC_API_KEY / AI_MODEL); analysis jobs will fail');

async function shutdown(signal: string) {
  logger.info(`${signal} received, draining workers`);
  await Promise.all(workers.map((w) => w.close()));
  await closeRedis();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
