import type { CrawlStatus, ExtractionMethod } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { contentRepository } from '../../repositories/content.repository.js';
import { crawlRepository, type CrawlCounters } from '../../repositories/crawl.repository.js';
import { logger } from '../../utils/logger.js';
import { normalizePageUrl } from '../../utils/url.js';
import { crawlerConfig, CRAWLER_VERSION, type CrawlerConfig } from './config.js';
import { contentHash } from './content-hash.js';
import { extractPage, type ExtractedPage } from './extract.js';
import { createFetcher, type Fetcher } from './fetcher.js';
import { Renderer } from './renderer.js';
import { loadRobotsTxt, robotsToken, type RobotsRules } from './robots.service.js';
import { decodeBody, FetchError, isHtmlContentType, networkPolicy, type NetworkPolicy } from './safe-fetch.js';
import { createScope, filterCandidates, type CrawlScope } from './scope.js';
import { defaultSitemapUrls, readSitemaps } from './sitemap.service.js';

export interface RunOptions {
  policy?: NetworkPolicy;
  /** Test hook: swap the renderer. */
  renderer?: Pick<Renderer, 'render' | 'close'>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces requests to the site by at least `delayMs`, across all concurrent workers. */
function rateGate(delayMs: number) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + delayMs;
    if (at > now) await sleep(at - now);
  };
}

type Website = NonNullable<Awaited<ReturnType<typeof crawlRepository.loadForRun>>>['website'];

class CrawlRun {
  private readonly counters: Required<CrawlCounters> = {
    pagesDiscovered: 0,
    pagesProcessed: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    pagesSkipped: 0,
    pagesCreated: 0,
    pagesUpdated: 0,
    pagesUnchanged: 0,
    renderedPages: 0,
  };
  private readonly queue: string[] = [];
  private readonly seen = new Set<string>();
  private readonly done = new Set<string>();
  private stopReason: 'cancelled' | 'page_limit' | 'time_limit' | null = null;
  private readonly deadline: number;
  private readonly fetcher: Fetcher;
  private readonly scope: CrawlScope;
  private readonly gate: () => Promise<void>;
  private robots!: RobotsRules;
  private discoverLinks = false;
  private renderer: Pick<Renderer, 'render' | 'close'> | null = null;

  constructor(
    private readonly jobId: string,
    private readonly website: Website,
    private readonly config: CrawlerConfig,
    private readonly opts: RunOptions,
  ) {
    this.scope = createScope(website);
    this.fetcher = createFetcher(config, this.scope.isSameSite, opts.policy);
    this.gate = rateGate(config.delayMs);
    this.deadline = Date.now() + config.maxDurationMs;
  }

  private log(extra: Record<string, unknown>, msg: string) {
    logger.info({ crawlId: this.jobId, websiteId: this.website.id, ...extra }, msg);
  }

  private enqueue(url: string) {
    if (this.seen.has(url)) return;
    this.seen.add(url);
    this.queue.push(url);
    this.counters.pagesDiscovered = this.seen.size;
  }

  async discover() {
    this.robots = await loadRobotsTxt(this.website.baseUrl, this.fetcher, this.config.userAgent);
    const declared = this.robots.getSitemaps();
    const sitemaps = await readSitemaps(declared.length ? declared : defaultSitemapUrls(this.website.baseUrl), this.fetcher, {
      isSameSite: this.scope.isSameSite,
      maxFiles: this.config.maxSitemapFiles,
      maxUrls: this.config.maxSitemapUrls,
    });
    const candidates = filterCandidates(
      sitemaps.entries.map((e) => e.url),
      this.scope,
    );

    if (candidates.length) {
      candidates.forEach((u) => this.enqueue(u));
    } else {
      // No usable sitemap: discover pages by following internal links from the start page.
      this.discoverLinks = true;
      const start = this.website.blogPathPrefix
        ? new URL(this.website.blogPathPrefix, this.website.baseUrl).toString()
        : this.website.baseUrl;
      const n = normalizePageUrl(start);
      if (n) this.enqueue(n);
    }

    await crawlRepository.update(this.jobId, {
      robotsFound: this.robots.found,
      discoveryMethod: this.discoverLinks ? 'links' : 'sitemap',
      sitemapUrls: { read: sitemaps.filesRead, errors: sitemaps.errors, truncated: sitemaps.truncated },
      pagesDiscovered: this.counters.pagesDiscovered,
    });
    this.log({ discovered: this.seen.size, method: this.discoverLinks ? 'links' : 'sitemap', sitemaps: sitemaps.filesRead.length }, 'Crawl discovery finished');
  }

  async processAll() {
    const workers = Array.from({ length: this.config.concurrency }, () => this.workerLoop());
    await Promise.all(workers);
  }

  private async workerLoop() {
    for (;;) {
      if (this.stopReason) return;
      if (this.counters.pagesProcessed + this.inFlight >= this.config.maxPages) {
        if (this.queue.length) this.stopReason ??= 'page_limit';
        return;
      }
      if (Date.now() > this.deadline) {
        this.stopReason ??= 'time_limit';
        return;
      }
      const url = this.queue.shift();
      if (!url) {
        if (this.inFlight === 0) return;
        await sleep(50); // another worker may still discover links
        continue;
      }
      if (await crawlRepository.cancelRequested(this.jobId)) {
        this.stopReason = 'cancelled';
        return;
      }
      this.inFlight++;
      const started = Date.now();
      try {
        await this.processUrl(url);
      } catch (err) {
        // Isolate unexpected per-page errors (DB conflict, parser bug): the crawl continues.
        logger.error({ crawlId: this.jobId, url, err }, 'Unexpected error while processing page');
        await this.record(url, started, { outcome: 'FAILED', errorCode: 'INTERNAL', errorMessage: (err as Error).message }).catch(() => {});
      } finally {
        this.inFlight--;
      }
    }
  }
  private inFlight = 0;

  private async record(
    url: string,
    started: number,
    r: {
      outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';
      finalUrl?: string | null;
      httpStatus?: number | null;
      method?: ExtractionMethod | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      pageId?: string | null;
      versionId?: string | null;
    },
  ) {
    const durationMs = Date.now() - started;
    await crawlRepository.recordResult({
      organizationId: this.website.organizationId,
      crawlJobId: this.jobId,
      url,
      finalUrl: r.finalUrl ?? null,
      outcome: r.outcome,
      httpStatus: r.httpStatus ?? null,
      extractionMethod: r.method ?? null,
      errorCode: r.errorCode ?? null,
      errorMessage: r.errorMessage ?? null,
      durationMs,
      pageId: r.pageId ?? null,
      versionId: r.versionId ?? null,
    });
    const c = this.counters;
    c.pagesProcessed++;
    if (r.outcome === 'FAILED') c.pagesFailed++;
    else if (r.outcome === 'SKIPPED') c.pagesSkipped++;
    else {
      c.pagesSucceeded++;
      if (r.outcome === 'CREATED') c.pagesCreated++;
      if (r.outcome === 'UPDATED') c.pagesUpdated++;
      if (r.outcome === 'UNCHANGED') c.pagesUnchanged++;
    }
    await crawlRepository.update(this.jobId, { ...c });
    this.log(
      { url, outcome: r.outcome, status: r.httpStatus ?? null, method: r.method ?? null, durationMs, error: r.errorCode ?? undefined },
      'Crawled page',
    );
  }

  private async fetchHtml(url: string) {
    await this.gate();
    let res = await this.fetcher(url, 'html');
    if (res.status === 429 || res.status === 503) {
      // One polite retry, honouring Retry-After (capped).
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000, 30_000));
      await this.gate();
      res = await this.fetcher(url, 'html');
    }
    return res;
  }

  private async processUrl(url: string) {
    const started = Date.now();
    const web = this.website;
    if (this.done.has(url)) {
      return this.record(url, started, { outcome: 'SKIPPED', errorCode: 'DUPLICATE', errorMessage: 'Already crawled via a redirect' });
    }
    if (!this.robots.isAllowed(url)) {
      return this.record(url, started, { outcome: 'SKIPPED', errorCode: 'ROBOTS_DISALLOWED', errorMessage: 'Disallowed by robots.txt' });
    }

    let res;
    try {
      res = await this.fetchHtml(url);
    } catch (err) {
      const fe = err instanceof FetchError ? err : new FetchError('NETWORK', (err as Error).message);
      if (fe.code === 'REDIRECT_OUT_OF_SCOPE') {
        await contentRepository.markPage(web, url, { status: 'REDIRECTED', redirectedTo: fe.details?.location ?? null, crawlJobId: this.jobId });
        return this.record(url, started, { outcome: 'SKIPPED', finalUrl: fe.details?.location, errorCode: fe.code, errorMessage: fe.message });
      }
      await contentRepository.markPage(web, url, { status: 'ERROR', crawlJobId: this.jobId });
      return this.record(url, started, { outcome: 'FAILED', errorCode: fe.code, errorMessage: fe.message });
    }

    const finalUrl = normalizePageUrl(res.finalUrl) ?? res.finalUrl;
    if (res.status === 404 || res.status === 410) {
      await contentRepository.markPage(web, url, { status: 'GONE', httpStatus: res.status, crawlJobId: this.jobId });
      return this.record(url, started, { outcome: 'FAILED', httpStatus: res.status, errorCode: `HTTP_${res.status}`, errorMessage: 'Page not found' });
    }
    if (res.status < 200 || res.status >= 300) {
      await contentRepository.markPage(web, url, { status: 'ERROR', httpStatus: res.status, crawlJobId: this.jobId });
      return this.record(url, started, { outcome: 'FAILED', httpStatus: res.status, errorCode: `HTTP_${res.status}`, errorMessage: `HTTP ${res.status}` });
    }
    if (!isHtmlContentType(res.contentType)) {
      return this.record(url, started, { outcome: 'SKIPPED', httpStatus: res.status, errorCode: 'NOT_HTML', errorMessage: res.contentType });
    }

    // Redirected within the site: the content belongs to the final URL's identity.
    let identity = url;
    if (finalUrl !== url) {
      await contentRepository.markPage(web, url, { status: 'REDIRECTED', httpStatus: res.redirects.length ? 301 : res.status, redirectedTo: finalUrl, crawlJobId: this.jobId });
      if (!this.scope.isCandidate(finalUrl) || !this.robots.isAllowed(finalUrl)) {
        return this.record(url, started, { outcome: 'SKIPPED', finalUrl, httpStatus: res.status, errorCode: 'REDIRECTED', errorMessage: `Redirects to ${finalUrl}` });
      }
      if (this.done.has(finalUrl)) {
        return this.record(url, started, { outcome: 'SKIPPED', finalUrl, httpStatus: res.status, errorCode: 'DUPLICATE', errorMessage: `Redirects to already-crawled ${finalUrl}` });
      }
      this.seen.add(finalUrl);
      identity = finalUrl;
    }
    this.done.add(identity);

    const rawHtml = decodeBody(res.body, res.contentType);
    const extractOpts = {
      pageUrl: res.finalUrl,
      isSameSite: this.scope.isSameSite,
      minContentWords: this.config.minContentWords,
      userAgentToken: robotsToken(this.config.userAgent),
      xRobotsTag: res.headers.get('x-robots-tag'),
      contentType: res.contentType,
    };
    let page: ExtractedPage = extractPage(rawHtml, extractOpts);
    let method: ExtractionMethod = 'HTTP_CHEERIO';
    let renderedHtml: string | null = null;
    let renderNote: string | null = null;

    if (!page.quality.sufficient && this.config.playwrightEnabled && this.counters.renderedPages < this.config.playwrightMaxPages) {
      try {
        this.renderer ??= this.opts.renderer ?? new Renderer(this.config, this.opts.policy ?? networkPolicy());
        this.counters.renderedPages++;
        const rendered = await this.renderer.render(res.finalUrl);
        const renderedPage = extractPage(rendered.html, extractOpts);
        if (renderedPage.wordCount > page.wordCount) {
          page = renderedPage;
          method = 'PLAYWRIGHT';
          renderedHtml = rendered.html;
        }
      } catch (err) {
        renderNote = `Render fallback failed: ${(err as Error).message}`;
        logger.warn({ crawlId: this.jobId, url, err: (err as Error).message }, 'Playwright fallback failed');
      }
    }

    if (this.discoverLinks) {
      for (const link of page.links) {
        if (link.isInternal && !link.nofollow && this.scope.isCandidate(link.targetUrl)) this.enqueue(link.targetUrl);
      }
    }

    const stored = await contentRepository.storeCrawledPage({
      website: web,
      crawlJobId: this.jobId,
      url: identity,
      httpStatus: res.status,
      method,
      crawlerVersion: CRAWLER_VERSION,
      page,
      hash: contentHash(page),
      rawHtml,
      renderedHtml,
    });
    return this.record(url, started, {
      outcome: stored.outcome,
      finalUrl: identity !== url ? identity : null,
      httpStatus: res.status,
      method,
      errorCode: renderNote ? 'RENDER_FAILED' : null,
      errorMessage: renderNote,
      pageId: stored.pageId,
      versionId: stored.versionId,
    });
  }

  async finish(error: string | null) {
    await this.renderer?.close();
    const c = this.counters;
    let status: CrawlStatus;
    let message = error;
    if (error) status = 'FAILED';
    else if (this.stopReason === 'cancelled') status = 'CANCELLED';
    else if (c.pagesSucceeded === 0 && c.pagesFailed > 0) status = 'FAILED';
    else if (c.pagesFailed > 0 || this.stopReason) {
      status = 'PARTIAL';
      if (this.stopReason === 'page_limit') message = `Stopped at the page limit (${this.config.maxPages})`;
      if (this.stopReason === 'time_limit') message = 'Stopped at the time limit';
    } else status = 'COMPLETED';

    await prisma.$transaction(async (tx) => {
      await tx.crawlJob.update({ where: { id: this.jobId }, data: { ...c, status, error: message, completedAt: new Date() } });
      await tx.website.update({ where: { id: this.website.id }, data: { lastCrawledAt: new Date() } });
      await auditRepository.record(
        {
          organizationId: this.website.organizationId,
          projectId: this.website.projectId,
          action: `crawl.${status.toLowerCase()}`,
          entityType: 'CrawlJob',
          entityId: this.jobId,
          metadata: { ...c, error: message },
        },
        tx,
      );
    });
    this.log({ status, ...c, error: message }, 'Crawl finished');
    return status;
  }
}

/** Runs one crawl job end to end. Never throws for page-level problems. */
export async function runCrawl(crawlJobId: string, opts: RunOptions = {}): Promise<CrawlStatus> {
  const job = await crawlRepository.loadForRun(crawlJobId);
  if (!job) throw new Error(`Crawl job ${crawlJobId} not found`);
  if (job.cancelRequestedAt) {
    await crawlRepository.transition(crawlJobId, ['PENDING'], { status: 'CANCELLED', completedAt: new Date() });
    return 'CANCELLED';
  }
  const started = await crawlRepository.transition(crawlJobId, ['PENDING'], { status: 'RUNNING', startedAt: new Date() });
  if (!started) throw new Error(`Crawl job ${crawlJobId} is not pending`);

  const config = crawlerConfig(job.config as Partial<CrawlerConfig>);
  const run = new CrawlRun(crawlJobId, job.website, config, opts);
  try {
    await run.discover();
    await run.processAll();
    return await run.finish(null);
  } catch (err) {
    logger.error({ crawlId: crawlJobId, err }, 'Crawl failed');
    return run.finish((err as Error).message.slice(0, 500));
  }
}
