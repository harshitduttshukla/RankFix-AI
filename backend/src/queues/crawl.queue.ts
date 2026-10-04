import { Queue } from 'bullmq';
import { redis } from '../config/redis.js';

export const CRAWL_QUEUE = 'website-crawl';

export interface CrawlJobData {
  crawlJobId: string;
}

let queue: Queue<CrawlJobData> | null = null;
export function crawlQueue() {
  queue ??= new Queue<CrawlJobData>(CRAWL_QUEUE, {
    connection: redis(),
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } },
  });
  return queue;
}

/** BullMQ job id = CrawlJob id, so a crawl can never be enqueued twice. */
export async function enqueueCrawl(crawlJobId: string) {
  await crawlQueue().add('crawl', { crawlJobId }, { jobId: crawlJobId });
}

export async function removeQueuedCrawl(crawlJobId: string) {
  const job = await crawlQueue().getJob(crawlJobId);
  if (job && (await job.isWaiting())) await job.remove();
}

export async function closeCrawlQueue() {
  await queue?.close();
  queue = null;
}
