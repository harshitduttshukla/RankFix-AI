import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { CRAWL_QUEUE, type CrawlJobData } from '../queues/crawl.queue.js';
import { crawlRepository } from '../repositories/crawl.repository.js';
import { crawlerConfig } from '../services/crawler/config.js';
import { runCrawl, type RunOptions } from '../services/crawler/crawl-runner.js';
import { logger } from '../utils/logger.js';

export async function failInterruptedCrawls() {
  const cutoff = new Date(Date.now() - crawlerConfig().maxDurationMs - 5 * 60_000);
  const { count } = await crawlRepository.failStale(cutoff);
  if (count) logger.warn({ count }, 'Marked interrupted crawls as FAILED');
}

export function startCrawlWorker(opts: RunOptions = {}) {
  const worker = new Worker<CrawlJobData>(CRAWL_QUEUE, (job) => runCrawl(job.data.crawlJobId, opts), {
    connection: redis(),
    concurrency: 2,
    lockDuration: 120_000,
  });
  worker.on('failed', (job, err) => {
    logger.error({ crawlId: job?.data.crawlJobId, err: err.message }, 'Crawl job crashed');
    if (job) {
      void crawlRepository.transition(job.data.crawlJobId, ['PENDING', 'RUNNING'], {
        status: 'FAILED',
        error: err.message.slice(0, 500),
        completedAt: new Date(),
      });
    }
  });
  return worker;
}
