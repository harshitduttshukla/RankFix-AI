import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedHostname, isBlockedIp } from '../src/services/crawler/ip-policy.js';
import { DEFAULT_POLICY, FetchError, decodeBody, resolvePublic, safeFetch, type NetworkPolicy } from '../src/services/crawler/safe-fetch.js';
import { createScope, filterCandidates } from '../src/services/crawler/scope.js';
import { FixtureSite, testPolicy } from './fixture-server.js';

const opts = (policy: NetworkPolicy, extra: Partial<Parameters<typeof safeFetch>[1]> = {}) => ({
  userAgent: 'BlogPilotBot/1.0',
  timeoutMs: 2000,
  maxBytes: 10_000,
  maxRedirects: 3,
  policy,
  ...extra,
});

describe('IP policy', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );

  it.each(['localhost', 'foo.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'intranet', '127.0.0.1', '[::1]'])(
    'blocks hostname %s',
    (h) => expect(isBlockedHostname(h)).toBe(true),
  );
  it('allows a normal public hostname', () => expect(isBlockedHostname('example.com')).toBe(false));
});

describe('SSRF protection with the default policy', () => {
  const rebinding: NetworkPolicy = {
    ...DEFAULT_POLICY,
    resolve: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 }, // any private answer rejects the host
    ],
  };

  it.each([
    'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/',
    'http://example.com:8080/', 'ftp://example.com/', 'http://user:pw@example.com/', 'file:///etc/passwd',
  ])('refuses %s', async (url) => {
    await expect(safeFetch(url, opts(DEFAULT_POLICY))).rejects.toBeInstanceOf(FetchError);
  });

  it('rejects public hostnames that resolve to private addresses (checked at connect time)', async () => {
    await expect(resolvePublic('evil.example.com', rebinding)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(safeFetch('http://evil.example.com/', opts(rebinding))).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
});

describe('safeFetch against a fixture server', () => {
  const site = new FixtureSite();
  const policy = testPolicy();
  beforeAll(async () => {
    await site.start();
    site.routes.set('/ok', '<html><body>hello</body></html>');
    site.routes.set('/r1', { status: 301, headers: { location: '/r2' } });
    site.routes.set('/r2', { status: 302, headers: { location: '/ok' } });
    site.routes.set('/loop', { status: 302, headers: { location: '/loop' } });
    site.routes.set('/offsite', { status: 302, headers: { location: 'https://elsewhere.example.org/' } });
    site.routes.set('/big', { body: 'x'.repeat(50_000) });
    site.routes.set('/slow', (_req, res) => setTimeout(() => res.end('late'), 3000));
    site.routes.set('/latin1', { type: 'text/html; charset=iso-8859-1', body: Buffer.from([0x63, 0x61, 0x66, 0xe9]) });
  });
  afterAll(() => site.stop());

  it('fetches HTML and sends the crawler user agent', async () => {
    const res = await safeFetch(site.url('blog.test', '/ok'), opts(policy));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('hello');
    expect(site.userAgents.at(-1)).toBe('BlogPilotBot/1.0');
  });

  it('follows redirects and reports the chain', async () => {
    const res = await safeFetch(site.url('blog.test', '/r1'), opts(policy));
    expect(res.finalUrl).toBe(site.url('blog.test', '/ok'));
    expect(res.redirects).toHaveLength(2);
  });

  it('stops at the redirect limit', async () => {
    await expect(safeFetch(site.url('blog.test', '/loop'), opts(policy))).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });
  });

  it('refuses redirects out of the website scope', async () => {
    const inScope = (u: string) => new URL(u).hostname === 'blog.test';
    await expect(safeFetch(site.url('blog.test', '/offsite'), opts(policy, { inScope }))).rejects.toMatchObject({
      code: 'REDIRECT_OUT_OF_SCOPE',
    });
  });

  it('re-validates every redirect hop against the network policy', async () => {
    // First hop is allowed; the redirect target uses a port outside the policy and must be refused.
    const portLocked: NetworkPolicy = { ...policy, allowedPorts: new Set([String(site.port)]) };
    site.routes.set('/to-bad-port', { status: 302, headers: { location: 'http://blog.test:1/' } });
    await expect(safeFetch(site.url('blog.test', '/to-bad-port'), opts(portLocked))).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(site.hits).toContain('/to-bad-port');
  });

  it('enforces the size cap', async () => {
    await expect(safeFetch(site.url('blog.test', '/big'), opts(policy))).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('times out slow responses', async () => {
    await expect(safeFetch(site.url('blog.test', '/slow'), opts(policy, { timeoutMs: 500 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('returns non-2xx responses for the caller to handle', async () => {
    const res = await safeFetch(site.url('blog.test', '/missing'), opts(policy));
    expect(res.status).toBe(404);
  });

  it('decodes using the declared charset', async () => {
    const res = await safeFetch(site.url('blog.test', '/latin1'), opts(policy));
    expect(decodeBody(res.body, res.contentType)).toBe('café');
  });
});

describe('crawl scope', () => {
  const scope = createScope({ hostname: 'www.example.com', blogPathPrefix: '/blog/' });

  it('accepts same-site blog pages including apex/www variants', () => {
    expect(scope.isCandidate('https://www.example.com/blog/post')).toBe(true);
    expect(scope.isCandidate('https://example.com/blog/post')).toBe(true);
    expect(scope.isCandidate('https://example.com/blog')).toBe(true);
  });

  it('rejects other hosts, subdomains, other paths and assets', () => {
    expect(scope.isCandidate('https://evil.com/blog/post')).toBe(false);
    expect(scope.isCandidate('https://shop.example.com/blog/post')).toBe(false);
    expect(scope.isCandidate('https://example.com/about')).toBe(false);
    expect(scope.isCandidate('https://example.com/blogroll')).toBe(false);
    expect(scope.isCandidate('https://example.com/blog/file.pdf')).toBe(false);
    expect(scope.isCandidate('mailto:a@example.com')).toBe(false);
  });

  it('normalizes and dedupes discovered URLs', () => {
    const out = filterCandidates(
      ['https://www.example.com/blog/a/', 'https://www.example.com/blog/a#x', 'https://www.example.com/blog/a?utm_source=t', 'https://www.example.com/blog/b?page=2', 'not a url'],
      scope,
    );
    expect(out).toEqual(['https://www.example.com/blog/a', 'https://www.example.com/blog/b?page=2']);
  });
});
