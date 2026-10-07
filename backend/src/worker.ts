import { prisma } from './config/database.js';
import { closeRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { failInterruptedCrawls, startCrawlWorker } from './workers/crawl.worker.js';
import { startGscWorker } from './workers/gsc.worker.js';
import { failInterruptedDetections, startOpportunityWorker } from './workers/opportunity.worker.js';

await failInterruptedCrawls();
await failInterruptedDetections();
const workers = [startGscWorker(), startCrawlWorker(), startOpportunityWorker()];
logger.info('Workers started: gsc-sync, website-crawl, opportunity-detect');

async function shutdown(signal: string) {
  logger.info(`${signal} received, draining workers`);
  await Promise.all(workers.map((w) => w.close()));
  await closeRedis();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
