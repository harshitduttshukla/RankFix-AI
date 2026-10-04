import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/database.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { closeCrawlQueue } from '../src/queues/crawl.queue.js';
import { crawlerConfig } from '../src/services/crawler/config.js';
import { runCrawl } from '../src/services/crawler/crawl-runner.js';
import { Renderer } from '../src/services/crawler/renderer.js';
import { DEFAULT_POLICY, setNetworkPolicy, type NetworkPolicy } from '../src/services/crawler/safe-fetch.js';
import { FixtureSite, testPolicy } from './fixture-server.js';
import { clientWithProject, resetDb } from './helpers.js';

const APP_JS = `
  const words = Array.from({ length: 150 }, (_, i) => 'rendered' + i).join(' ');
  document.getElementById('root').innerHTML =
    '<article><h1>Client Rendered Post</h1><h2>Section A</h2><p>' + words + '</p></article>';
  fetch('http://other.test:1/secret')
    .then(() => document.body.insertAdjacentHTML('beforeend', '<p id="probe">fetch allowed</p>'))
    .catch(() => document.body.insertAdjacentHTML('beforeend', '<p id="probe">fetch blocked</p>'));
`;

let site: FixtureSite;
let policy: NetworkPolicy;

beforeAll(async () => {
  site = await new FixtureSite().start();
  // Loopback fixture allowed, but only on the fixture's own port: anything else must be refused.
  policy = { ...testPolicy(), allowedPorts: new Set([String(site.port)]) };
  site.routes.set('/robots.txt', { type: 'text/plain', body: `User-agent: *\nAllow: /\nSitemap: ${site.url('spa.test', '/sitemap.xml')}` });
  site.routes.set('/sitemap.xml', { type: 'application/xml', body: `<urlset><url><loc>${site.url('spa.test', '/blog/spa')}</loc></url></urlset>` });
  site.routes.set('/blog/spa', '<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src="/app.js"></script></body></html>');
  site.routes.set('/app.js', { type: 'application/javascript', body: APP_JS });
  site.routes.set('/logo.png', { type: 'image/png', body: 'png' });
});
afterAll(async () => {
  setNetworkPolicy(DEFAULT_POLICY);
  await site.stop();
  await closeCrawlQueue();
  await closeRedis();
  await prisma.$disconnect();
});

describe('Playwright fallback (real Chromium)', () => {
  it('renders a JavaScript-only page and blocks requests outside the network policy', async () => {
    const renderer = new Renderer(crawlerConfig({ playwrightTimeoutMs: 15_000 }), policy);
    try {
      const out = await renderer.render(site.url('spa.test', '/blog/spa'));
      expect(out.html).toContain('<h1>Client Rendered Post</h1>');
      expect(out.html).toContain('fetch blocked');
      expect(site.hits).toContain('/app.js'); // script was fetched through safeFetch and fulfilled
    } finally {
      await renderer.close();
    }
  }, 60_000);

  it('stores a PLAYWRIGHT version for an app-shell page during a crawl', async () => {
    await resetDb();
    await redis().flushdb();
    setNetworkPolicy(policy);
    const c = await clientWithProject('spa');
    const web = await prisma.website.create({
      data: { organizationId: c.project.organizationId, projectId: c.project.id, baseUrl: site.url('spa.test').replace(/\/$/, ''), hostname: 'spa.test' },
    });
    const job = (await c.post(`/api/websites/${web.id}/crawl`).expect(202)).body;
    expect(await runCrawl(job.id)).toBe('COMPLETED');

    const v = await prisma.contentPageVersion.findFirstOrThrow({ include: { pageSections: { orderBy: { order: 'asc' } } } });
    expect(v.extractionMethod).toBe('PLAYWRIGHT');
    expect(v.rawHtml).toContain('<div id="root"></div>');
    expect(v.renderedHtml).toContain('Client Rendered Post');
    expect(v.pageSections.map((s) => s.heading)).toEqual(['Client Rendered Post', 'Section A']);
    expect((await prisma.crawlJob.findUniqueOrThrow({ where: { id: job.id } })).renderedPages).toBe(1);
  }, 60_000);
});
