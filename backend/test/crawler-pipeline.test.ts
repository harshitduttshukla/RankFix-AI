import { readFileSync } from 'node:fs';
import { QueueEvents } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/database.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { closeCrawlQueue, CRAWL_QUEUE, crawlQueue } from '../src/queues/crawl.queue.js';
import { runCrawl } from '../src/services/crawler/crawl-runner.js';
import { DEFAULT_POLICY, setNetworkPolicy } from '../src/services/crawler/safe-fetch.js';
import { startCrawlWorker } from '../src/workers/crawl.worker.js';
import { FixtureSite, testPolicy } from './fixture-server.js';
import { clientWithProject, resetDb } from './helpers.js';

const article = readFileSync(new URL('./fixtures/blog-post.html', import.meta.url), 'utf8');
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const simplePage = (title: string, body = words(80)) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
const sitemap = (paths: string[], site: FixtureSite) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${p.startsWith('http') ? p : site.url('blog.test', p)}</loc></url>`).join('')}</urlset>`;

/** Renderer stub: deterministic "JavaScript output" without a browser (real Playwright is tested separately). */
const fakeRenderer = {
  calls: [] as string[],
  render: async (url: string) => {
    fakeRenderer.calls.push(url);
    return { html: simplePage('Rendered by JS', words(120)), finalUrl: url };
  },
  close: async () => {},
};

let site: FixtureSite;
type C = Awaited<ReturnType<typeof clientWithProject>>;

async function websiteFor(c: C, prefix: string | null = '/blog/') {
  // Created directly: the fixture runs on a random local port, which the public API (correctly) refuses.
  return prisma.website.create({
    data: {
      organizationId: c.project.organizationId,
      projectId: c.project.id,
      baseUrl: site.url('blog.test').replace(/\/$/, ''),
      hostname: 'blog.test',
      blogPathPrefix: prefix,
    },
  });
}

async function crawl(c: C, websiteId: string) {
  const job = (await c.post(`/api/websites/${websiteId}/crawl`).expect(202)).body;
  const status = await runCrawl(job.id, { renderer: fakeRenderer });
  return { job, status, detail: (await c.get(`/api/websites/${websiteId}/crawls/${job.id}`).expect(200)).body };
}

beforeAll(async () => {
  site = await new FixtureSite().start();
});
afterAll(async () => {
  await site.stop();
  await closeCrawlQueue();
  await closeRedis();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  await redis().flushdb();
  setNetworkPolicy(testPolicy());
  site.routes.clear();
  site.hits = [];
  fakeRenderer.calls = [];
  site.routes.set('/robots.txt', { type: 'text/plain', body: `User-agent: *\nDisallow: /blog/secret\nSitemap: ${site.url('blog.test', '/sitemap.xml')}` });
  site.routes.set(
    '/sitemap.xml',
    {
      type: 'application/xml',
      body: sitemap(
        ['/blog/react', '/blog/second', '/blog/secret', '/blog/missing', '/blog/old', '/blog/guide.pdf', '/blog/file', '/blog/broken', '/blog/app', '/about', 'https://other.example.com/blog/x'],
        site,
      ),
    },
  );
  site.routes.set('/blog/react', article);
  site.routes.set('/blog/second', simplePage('Second post'));
  site.routes.set('/blog/secret', simplePage('Secret'));
  site.routes.set('/blog/old', { status: 301, headers: { location: '/blog/second' } });
  site.routes.set('/blog/file', { type: 'application/pdf', body: '%PDF-1.4' });
  site.routes.set('/blog/broken', { status: 500, body: 'oops' });
  site.routes.set('/blog/app', '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  site.routes.set('/about', simplePage('About'));
});
afterEach(() => setNetworkPolicy(DEFAULT_POLICY));

describe('crawl pipeline', () => {
  it('discovers via robots + sitemap, respects scope and robots, and isolates failures', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const { status, detail } = await crawl(c, web.id);

    expect(status).toBe('PARTIAL'); // 404 and 500 failed, the rest succeeded
    expect(detail).toMatchObject({ discoveryMethod: 'sitemap', robotsFound: true, pagesDiscovered: 8, pagesCreated: 3, pagesFailed: 2 });
    // /about (outside /blog/), the .pdf and the off-site URL are filtered at discovery
    expect(site.hits).not.toContain('/about');
    expect(site.hits).not.toContain('/blog/guide.pdf');
    // robots.txt disallow: recorded as skipped, never requested
    expect(site.hits).not.toContain('/blog/secret');
    const skipped = Object.fromEntries(detail.skipped.map((r: { url: string; errorCode: string }) => [new URL(r.url).pathname, r.errorCode]));
    expect(skipped).toMatchObject({ '/blog/secret': 'ROBOTS_DISALLOWED', '/blog/file': 'NOT_HTML', '/blog/old': 'DUPLICATE' });
    const failed = Object.fromEntries(detail.failures.map((r: { url: string; errorCode: string }) => [new URL(r.url).pathname, r.errorCode]));
    expect(failed).toEqual({ '/blog/missing': 'HTTP_404', '/blog/broken': 'HTTP_500' });

    const pages = await prisma.contentPage.findMany({ orderBy: { url: 'asc' } });
    expect(pages.map((p) => new URL(p.url).pathname)).toEqual(['/blog/app', '/blog/react', '/blog/second']);
    expect(pages.every((p) => p.organizationId === c.project.organizationId && p.projectId === c.project.id)).toBe(true);
  });

  it('stores structure, raw HTML, hash, links, images and JSON-LD for each version', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    await crawl(c, web.id);
    const page = await prisma.contentPage.findFirstOrThrow({
      where: { url: site.url('blog.test', '/blog/react') },
      include: { currentVersion: { include: { pageSections: { orderBy: { order: 'asc' } }, links: true, images: true, structuredData: true } } },
    });
    const v = page.currentVersion!;
    expect(page).toMatchObject({ status: 'ACTIVE', httpStatus: 200, canonicalUrl: 'http://blog.test:' + site.port + '/guides/react', currentVersionNo: 1 });
    expect(v).toMatchObject({ versionNo: 1, source: 'CRAWL', title: 'Complete React Guide | Acme Blog', extractionMethod: 'HTTP_CHEERIO', crawlerVersion: '1.0.0', invalidJsonLd: 1 });
    expect(v.rawHtml).toBe(article);
    expect(v.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(v.pageSections.map((s) => s.heading)).toEqual(['Complete React Guide', 'What is React?', 'Why use React?', 'React Components']);
    expect(v.pageSections[1]!.html).toContain('<h2>What is React?</h2>');
    expect(v.links.find((l) => l.anchorText === 'components')).toMatchObject({ isInternal: true, inContent: true });
    expect(v.images.find((i) => i.src.endsWith('/img/react-arch.png'))).toMatchObject({ alt: 'React architecture', width: 800 });
    expect(v.structuredData.map((d) => d.types)).toEqual([['Article'], ['BreadcrumbList', 'WebPage', 'FAQPage']]);
  });

  it('falls back to the renderer only when HTTP content is insufficient', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    await crawl(c, web.id);
    expect(fakeRenderer.calls).toEqual([site.url('blog.test', '/blog/app')]);
    const v = await prisma.contentPageVersion.findFirstOrThrow({ where: { page: { url: site.url('blog.test', '/blog/app') } } });
    expect(v.extractionMethod).toBe('PLAYWRIGHT');
    expect(v.rawHtml).toContain('<div id="root"></div>'); // original response is still the source snapshot
    expect(v.renderedHtml).toContain('Rendered by JS');
    expect(v.wordCount).toBeGreaterThan(100);
  });

  it('does not create versions for unchanged pages, and preserves history when content changes', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    await crawl(c, web.id);
    const second = await crawl(c, web.id);
    expect(second.detail).toMatchObject({ pagesCreated: 0, pagesUpdated: 0, pagesUnchanged: 3 });
    expect(await prisma.contentPageVersion.count()).toBe(3);

    site.routes.set('/blog/react', article.replace('released as open source in 2013', 'released as open source in May 2013'));
    const third = await crawl(c, web.id);
    expect(third.detail).toMatchObject({ pagesUpdated: 1, pagesUnchanged: 2 });
    const versions = await prisma.contentPageVersion.findMany({ where: { page: { url: site.url('blog.test', '/blog/react') } }, orderBy: { versionNo: 'asc' } });
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(versions[0]!.bodyText).toContain('in 2013');
    expect(versions[1]!.bodyText).toContain('in May 2013');
    const page = await prisma.contentPage.findFirstOrThrow({ where: { url: site.url('blog.test', '/blog/react') } });
    expect(page).toMatchObject({ currentVersionId: versions[1]!.id, currentVersionNo: 2 });
  });

  it('marks a previously crawled page GONE when it starts returning 404', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    await crawl(c, web.id);
    site.routes.delete('/blog/second');
    await crawl(c, web.id);
    const page = await prisma.contentPage.findFirstOrThrow({ where: { url: site.url('blog.test', '/blog/second') } });
    expect(page).toMatchObject({ status: 'GONE', httpStatus: 404, currentVersionNo: 1 }); // history kept
  });

  it('falls back to following internal links when there is no sitemap', async () => {
    site.routes.delete('/sitemap.xml');
    site.routes.set('/robots.txt', { type: 'text/plain', body: 'User-agent: *\nAllow: /' });
    site.routes.set('/blog', `<html><body><main><h1>Blog</h1><p>${words(60)}</p><a href="/blog/second">Second</a><a href="/blog/react#top">React</a><a href="https://elsewhere.example/">x</a></main></body></html>`);
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const { detail } = await crawl(c, web.id);
    expect(detail.discoveryMethod).toBe('links');
    const urls = (await prisma.contentPage.findMany()).map((p) => new URL(p.url).pathname).sort();
    expect(urls).toEqual(['/blog', '/blog/react', '/blog/second']);
  });

  it('stops at the page limit with PARTIAL', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const job = (await c.post(`/api/websites/${web.id}/crawl`).expect(202)).body;
    await prisma.crawlJob.update({ where: { id: job.id }, data: { config: { maxPages: 2 } } });
    expect(await runCrawl(job.id, { renderer: fakeRenderer })).toBe('PARTIAL');
    const row = await prisma.crawlJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.pagesProcessed).toBe(2);
    expect(row.error).toBe('Stopped at the page limit (2)');
  });

  it('fails the crawl (not individual pages) when robots.txt is unavailable', async () => {
    site.routes.set('/robots.txt', { status: 503 });
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const { status, detail } = await crawl(c, web.id);
    expect(status).toBe('FAILED');
    expect(detail.error).toMatch(/robots\.txt returned HTTP 503/);
  });

  it('refuses to crawl a site that resolves to a private address (SSRF)', async () => {
    setNetworkPolicy({ ...testPolicy(), allowPrivate: false });
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const { status, detail } = await crawl(c, web.id);
    expect(status).toBe('FAILED');
    expect(detail.error).toMatch(/private or reserved address/);
    expect(site.hits).toEqual([]);
  });
});

describe('crawl jobs & cancellation', () => {
  it('allows only one active crawl per website', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    await c.post(`/api/websites/${web.id}/crawl`).expect(202);
    const res = await c.post(`/api/websites/${web.id}/crawl`).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('cancels a pending crawl', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const job = (await c.post(`/api/websites/${web.id}/crawl`).expect(202)).body;
    const res = await c.post(`/api/websites/${web.id}/crawls/${job.id}/cancel`).expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(await crawlQueue().getJob(job.id)).toBeUndefined();
    await c.post(`/api/websites/${web.id}/crawls/${job.id}/cancel`).expect(409);
  });

  it('cancels a running crawl between pages', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const job = (await c.post(`/api/websites/${web.id}/crawl`).expect(202)).body;
    // Request cancellation as soon as the first page is fetched.
    site.routes.set('/blog/react', (_req, res) => {
      void c.post(`/api/websites/${web.id}/crawls/${job.id}/cancel`).then(() => res.end(article));
    });
    expect(await runCrawl(job.id, { renderer: fakeRenderer })).toBe('CANCELLED');
    const row = await prisma.crawlJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.pagesProcessed).toBe(1);
  });

  it('runs end to end through BullMQ', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    const worker = startCrawlWorker({ renderer: fakeRenderer });
    const events = new QueueEvents(CRAWL_QUEUE, { connection: redis().duplicate() });
    await events.waitUntilReady();
    try {
      const job = (await c.post(`/api/websites/${web.id}/crawl`).expect(202)).body;
      expect(job.status).toBe('PENDING');
      await (await crawlQueue().getJob(job.id))!.waitUntilFinished(events, 20_000);
      const done = (await c.get(`/api/websites/${web.id}/crawls/${job.id}`).expect(200)).body;
      expect(done.status).toBe('PARTIAL');
      expect(done.pagesCreated).toBe(3);
    } finally {
      await worker.close();
      await events.close();
    }
  });
});

describe('pages API, authorization & tenant isolation', () => {
  it('lists pages and returns structured detail without raw HTML', async () => {
    const c = await clientWithProject('alice');
    const web = await websiteFor(c);
    await crawl(c, web.id);
    const list = (await c.get(`/api/websites/${web.id}/pages`).expect(200)).body;
    expect(list.items).toHaveLength(3);
    expect(list.counts).toEqual({ ACTIVE: 3 });
    const react = list.items.find((p: { url: string }) => p.url.endsWith('/blog/react'));
    expect(react).toMatchObject({ title: 'Complete React Guide | Acme Blog', extractionMethod: 'HTTP_CHEERIO', status: 'ACTIVE' });

    const detail = (await c.get(`/api/websites/${web.id}/pages/${react.id}`).expect(200)).body;
    expect(detail.currentVersion.pageSections).toHaveLength(4);
    expect(detail.currentVersion.links.length).toBeGreaterThan(3);
    expect(JSON.stringify(detail)).not.toContain('window.analytics'); // raw HTML is not exposed
    const versions = (await c.get(`/api/websites/${web.id}/pages/${react.id}/versions`).expect(200)).body;
    expect(versions.items).toHaveLength(1);
    expect((await c.get(`/api/websites/${web.id}/pages?q=react`).expect(200)).body.items).toHaveLength(1);
  });

  it('hides crawls and pages from other tenants and blocks viewers from crawling', async () => {
    const alice = await clientWithProject('alice');
    const web = await websiteFor(alice);
    const { job } = await crawl(alice, web.id);
    const page = await prisma.contentPage.findFirstOrThrow();

    const bob = await clientWithProject('bob');
    await bob.post(`/api/websites/${web.id}/crawl`).expect(404);
    await bob.get(`/api/websites/${web.id}/crawls`).expect(404);
    await bob.get(`/api/websites/${web.id}/crawls/${job.id}`).expect(404);
    await bob.get(`/api/websites/${web.id}/pages`).expect(404);
    await bob.get(`/api/websites/${web.id}/pages/${page.id}`).expect(404);
    await bob.get(`/api/websites/${web.id}/pages/${page.id}/versions`).expect(404);

    // A page id from another website can't be read through a website you do own.
    const bobWeb = await websiteFor(bob);
    await bob.get(`/api/websites/${bobWeb.id}/pages/${page.id}`).expect(404);

    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: alice.project.organizationId, role: 'VIEWER' } });
    await viewer.get(`/api/websites/${web.id}/pages`).expect(200);
    await viewer.post(`/api/websites/${web.id}/crawl`).expect(403);
  });
});
