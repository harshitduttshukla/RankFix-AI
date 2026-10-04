import { env } from '../../config/env.js';

export const CRAWLER_VERSION = '1.0.0';

export interface CrawlerConfig {
  userAgent: string;
  maxPages: number;
  concurrency: number;
  requestTimeoutMs: number;
  delayMs: number;
  maxDurationMs: number;
  maxResponseBytes: number;
  minContentWords: number;
  playwrightEnabled: boolean;
  playwrightMaxPages: number;
  playwrightTimeoutMs: number;
  maxRedirects: number;
  maxSitemapFiles: number;
  maxSitemapUrls: number;
}

export function crawlerConfig(overrides: Partial<CrawlerConfig> = {}): CrawlerConfig {
  return {
    userAgent: env.CRAWLER_USER_AGENT,
    maxPages: env.CRAWLER_MAX_PAGES,
    concurrency: env.CRAWLER_CONCURRENCY,
    requestTimeoutMs: env.CRAWLER_REQUEST_TIMEOUT_MS,
    delayMs: env.CRAWLER_DELAY_MS,
    maxDurationMs: env.CRAWLER_MAX_DURATION_MS,
    maxResponseBytes: env.CRAWLER_MAX_RESPONSE_BYTES,
    minContentWords: env.CRAWLER_MIN_CONTENT_WORDS,
    playwrightEnabled: env.CRAWLER_PLAYWRIGHT_ENABLED,
    playwrightMaxPages: env.CRAWLER_PLAYWRIGHT_MAX_PAGES,
    playwrightTimeoutMs: env.CRAWLER_PLAYWRIGHT_TIMEOUT_MS,
    maxRedirects: 5,
    maxSitemapFiles: 50,
    maxSitemapUrls: 50_000,
    ...overrides,
  };
}
