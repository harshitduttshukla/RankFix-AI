import type { CrawlerConfig } from './config.js';
import { safeFetch, type NetworkPolicy, type SafeFetchResult } from './safe-fetch.js';

export type Fetcher = (url: string, kind: 'html' | 'xml' | 'text') => Promise<SafeFetchResult>;

const ACCEPT = {
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  xml: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
  text: 'text/plain,*/*;q=0.5',
};

/** Crawler-configured fetcher bound to one website's scope. */
export function createFetcher(config: CrawlerConfig, inScope: (url: string) => boolean, policy?: NetworkPolicy): Fetcher {
  return (url, kind) =>
    safeFetch(url, {
      userAgent: config.userAgent,
      timeoutMs: config.requestTimeoutMs,
      maxBytes: kind === 'xml' ? Math.max(config.maxResponseBytes, 20 * 1024 * 1024) : config.maxResponseBytes,
      maxRedirects: config.maxRedirects,
      accept: ACCEPT[kind],
      inScope,
      policy,
    });
}
