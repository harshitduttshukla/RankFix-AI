import { createRequire } from 'node:module';
import { FetchError } from './safe-fetch.js';
import type { Fetcher } from './fetcher.js';
import { decodeBody } from './safe-fetch.js';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

// robots-parser is CommonJS (module.exports = fn); its bundled typings don't resolve under NodeNext.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, contents: string) => Robot;

/** The product token robots.txt groups are matched against, e.g. "BlogPilotBot". */
export const robotsToken = (userAgent: string) => userAgent.split('/')[0]!.trim();

export class RobotsRules {
  constructor(
    private readonly robot: Robot | null,
    private readonly userAgent: string,
    readonly found: boolean,
    readonly disallowAll = false,
  ) {}

  static allowAll(userAgent: string) {
    return new RobotsRules(null, userAgent, false);
  }

  isAllowed(url: string): boolean {
    if (this.disallowAll) return false;
    if (!this.robot) return true;
    return this.robot.isAllowed(url, robotsToken(this.userAgent)) !== false;
  }

  getSitemaps(): string[] {
    return this.robot?.getSitemaps() ?? [];
  }

  /** Crawl-delay in ms, capped at 10s so a hostile value can't stall a crawl. */
  crawlDelayMs(): number | undefined {
    const d = this.robot?.getCrawlDelay(robotsToken(this.userAgent));
    return d === undefined || Number.isNaN(d) ? undefined : Math.min(d * 1000, 10_000);
  }
}

export class RobotsUnavailableError extends Error {}

/**
 * Loads /robots.txt.
 * 2xx → parse · 4xx → no restrictions (standard behaviour) · 5xx / network error → refuse to crawl.
 */
export async function loadRobotsTxt(origin: string, fetcher: Fetcher, userAgent: string): Promise<RobotsRules> {
  const robotsUrl = new URL('/robots.txt', origin).toString();
  try {
    const res = await fetcher(robotsUrl, 'text');
    if (res.status >= 200 && res.status < 300) {
      // Rules apply to the host they were served for (after redirects such as apex → www).
      const robot = robotsParser(res.finalUrl, decodeBody(res.body, res.contentType));
      return new RobotsRules(robot, userAgent, true);
    }
    if (res.status >= 400 && res.status < 500) return RobotsRules.allowAll(userAgent);
    throw new RobotsUnavailableError(`robots.txt returned HTTP ${res.status}; not crawling to be safe`);
  } catch (err) {
    if (err instanceof RobotsUnavailableError) throw err;
    if (err instanceof FetchError && (err.code === 'SSRF_BLOCKED' || err.code === 'INVALID_URL')) throw err;
    if (err instanceof FetchError && err.code === 'REDIRECT_OUT_OF_SCOPE') return RobotsRules.allowAll(userAgent);
    throw new RobotsUnavailableError(`robots.txt could not be fetched (${(err as Error).message}); not crawling to be safe`);
  }
}
