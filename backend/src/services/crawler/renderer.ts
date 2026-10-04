import { chromium, type Browser, type Route } from 'playwright';
import { logger } from '../../utils/logger.js';
import type { CrawlerConfig } from './config.js';
import { safeFetch, type NetworkPolicy, networkPolicy } from './safe-fetch.js';

export interface RenderResult {
  html: string;
  finalUrl: string;
}

const PASS_THROUGH = new Set(['document', 'script', 'xhr', 'fetch', 'stylesheet']);

/**
 * Playwright fallback for JavaScript-rendered pages.
 * The browser never touches the network directly: every allowed request is performed by safeFetch
 * (SSRF-checked, size/time-capped, redirects re-validated) and fulfilled into the page.
 * Images, media, fonts, websockets and non-GET requests are blocked.
 */
export class Renderer {
  private browser: Browser | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: CrawlerConfig,
    private readonly policy: NetworkPolicy = networkPolicy(),
  ) {}

  /** Serialized: at most one page renders at a time per crawl. */
  render(url: string): Promise<RenderResult> {
    const run = this.busy.then(() => this.renderOne(url));
    this.busy = run.catch(() => {});
    return run;
  }

  private async renderOne(url: string): Promise<RenderResult> {
    this.browser ??= await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-first-run'] });
    const context = await this.browser.newContext({
      userAgent: this.config.userAgent,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    try {
      await context.routeWebSocket(/.*/, (ws) => ws.close());
      await context.route('**/*', (route) => this.handle(route));
      const page = await context.newPage();
      page.setDefaultTimeout(this.config.playwrightTimeoutMs);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.playwrightTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.min(8000, this.config.playwrightTimeoutMs) }).catch(() => {});
      return { html: await page.content(), finalUrl: page.url() };
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async handle(route: Route) {
    const req = route.request();
    if (req.method() !== 'GET' || !PASS_THROUGH.has(req.resourceType())) return route.abort('blockedbyclient');
    try {
      const res = await safeFetch(req.url(), {
        userAgent: this.config.userAgent,
        timeoutMs: this.config.requestTimeoutMs,
        maxBytes: this.config.maxResponseBytes,
        maxRedirects: this.config.maxRedirects,
        accept: req.headers()['accept'],
        policy: this.policy,
      });
      await route.fulfill({
        status: res.status,
        headers: res.contentType ? { 'content-type': res.contentType } : {},
        body: res.body,
      });
    } catch (err) {
      logger.debug({ url: req.url(), err: (err as Error).message }, 'Renderer blocked or failed request');
      await route.abort('blockedbyclient').catch(() => {});
    }
  }

  async close() {
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => {});
  }
}
