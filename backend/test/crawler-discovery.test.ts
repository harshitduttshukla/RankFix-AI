import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlerConfig } from '../src/services/crawler/config.js';
import { createFetcher } from '../src/services/crawler/fetcher.js';
import { loadRobotsTxt, RobotsUnavailableError } from '../src/services/crawler/robots.service.js';
import { createScope } from '../src/services/crawler/scope.js';
import { defaultSitemapUrls, parseSitemap, readSitemaps } from '../src/services/crawler/sitemap.service.js';
import { FixtureSite, testPolicy } from './fixture-server.js';

const urlset = (urls: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>\n  ${u}\n</loc><lastmod>2026-09-01</lastmod></url>`)
    .join('')}</urlset>`;
const index = (urls: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;

describe('parseSitemap', () => {
  it('parses a urlset with lastmod and trims whitespace', () => {
    const p = parseSitemap(Buffer.from(urlset(['https://e.com/a', 'https://e.com/b'])));
    expect(p.kind).toBe('urlset');
    expect(p.locs).toEqual([
      { url: 'https://e.com/a', lastmod: '2026-09-01' },
      { url: 'https://e.com/b', lastmod: '2026-09-01' },
    ]);
  });

  it('parses a sitemap index', () => {
    const p = parseSitemap(Buffer.from(index(['https://e.com/posts.xml', 'https://e.com/pages.xml'])));
    expect(p.kind).toBe('index');
    expect(p.locs.map((l) => l.url)).toEqual(['https://e.com/posts.xml', 'https://e.com/pages.xml']);
  });

  it('parses gzip and plain-text sitemaps', () => {
    expect(parseSitemap(gzipSync(urlset(['https://e.com/z']))).locs[0]!.url).toBe('https://e.com/z');
    expect(parseSitemap(Buffer.from('https://e.com/1\nhttps://e.com/2\n# comment')).locs).toHaveLength(2);
  });

  it('returns unknown for non-sitemap documents', () => {
    expect(parseSitemap(Buffer.from('<html><body>hi</body></html>')).kind).toBe('unknown');
  });
});

describe('robots.txt + sitemap discovery against a fixture site', () => {
  const site = new FixtureSite();
  let fetcher: ReturnType<typeof createFetcher>;
  let origin: string;
  const cfg = crawlerConfig({ requestTimeoutMs: 2000 });

  beforeAll(async () => {
    await site.start();
    origin = site.url('blog.test');
    const scope = createScope({ hostname: 'blog.test', blogPathPrefix: null });
    fetcher = createFetcher(cfg, scope.isSameSite, testPolicy());
    site.routes.set('/robots.txt', {
      type: 'text/plain',
      body: [
        'User-agent: *',
        'Disallow: /private/',
        '',
        'User-agent: BlogPilotBot',
        'Disallow: /drafts/',
        'Allow: /drafts/public',
        'Crawl-delay: 2',
        '',
        `Sitemap: ${site.url('blog.test', '/sitemap_index.xml')}`,
        'Sitemap: https://other-domain.example/sitemap.xml',
      ].join('\n'),
    });
    site.routes.set('/sitemap_index.xml', { type: 'application/xml', body: index([site.url('blog.test', '/posts.xml'), site.url('blog.test', '/pages.xml.gz'), site.url('blog.test', '/broken.xml'), 'https://other-domain.example/s.xml']) });
    site.routes.set('/posts.xml', { type: 'application/xml', body: urlset([site.url('blog.test', '/blog/a'), site.url('blog.test', '/blog/b')]) });
    site.routes.set('/pages.xml.gz', { type: 'application/octet-stream', body: gzipSync(urlset([site.url('blog.test', '/about')])) });
    site.routes.set('/broken.xml', { status: 500 });
  });
  afterAll(() => site.stop());

  it('applies the most specific user-agent group', async () => {
    const rules = await loadRobotsTxt(origin, fetcher, cfg.userAgent);
    expect(rules.found).toBe(true);
    expect(rules.isAllowed(site.url('blog.test', '/blog/a'))).toBe(true);
    expect(rules.isAllowed(site.url('blog.test', '/drafts/x'))).toBe(false);
    expect(rules.isAllowed(site.url('blog.test', '/drafts/public'))).toBe(true);
    // Our specific group replaces the * group, as the robots standard requires.
    expect(rules.isAllowed(site.url('blog.test', '/private/x'))).toBe(true);
    expect(rules.crawlDelayMs()).toBe(2000);
    expect(rules.getSitemaps()).toContain(site.url('blog.test', '/sitemap_index.xml'));
  });

  it('follows sitemap indexes (incl. gzip), skips off-site and broken files', async () => {
    const rules = await loadRobotsTxt(origin, fetcher, cfg.userAgent);
    const scope = createScope({ hostname: 'blog.test', blogPathPrefix: null });
    const res = await readSitemaps(rules.getSitemaps(), fetcher, { isSameSite: scope.isSameSite, maxFiles: 10, maxUrls: 100 });
    expect(res.entries.map((e) => new URL(e.url).pathname)).toEqual(['/blog/a', '/blog/b', '/about']);
    expect(res.filesRead).toHaveLength(3);
    expect(res.errors).toEqual([{ url: site.url('blog.test', '/broken.xml'), message: 'HTTP 500' }]);
  });

  it('enforces file and URL limits', async () => {
    const scope = createScope({ hostname: 'blog.test', blogPathPrefix: null });
    const res = await readSitemaps([site.url('blog.test', '/sitemap_index.xml')], fetcher, { isSameSite: scope.isSameSite, maxFiles: 2, maxUrls: 1 });
    expect(res.entries).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });

  it('treats a missing robots.txt as no restrictions', async () => {
    const other = new FixtureSite();
    await other.start();
    try {
      const f = createFetcher(cfg, () => true, testPolicy());
      const rules = await loadRobotsTxt(other.url('new.test'), f, cfg.userAgent);
      expect(rules.found).toBe(false);
      expect(rules.isAllowed(other.url('new.test', '/anything'))).toBe(true);
      expect(defaultSitemapUrls(other.url('new.test'))[0]).toBe(other.url('new.test', '/sitemap.xml'));
    } finally {
      await other.stop();
    }
  });

  it('refuses to crawl when robots.txt errors (5xx)', async () => {
    const other = new FixtureSite();
    await other.start();
    other.routes.set('/robots.txt', { status: 503 });
    try {
      await expect(loadRobotsTxt(other.url('down.test'), createFetcher(cfg, () => true, testPolicy()), cfg.userAgent)).rejects.toBeInstanceOf(
        RobotsUnavailableError,
      );
    } finally {
      await other.stop();
    }
  });
});
