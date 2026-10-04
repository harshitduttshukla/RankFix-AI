import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/services/gsc/gsc-sync.service.js';
import { normalizePageUrl, propertyCoversHost } from '../src/utils/url.js';

describe('normalizePageUrl', () => {
  it.each([
    ['https://Example.com/Blog/Post/', 'https://example.com/Blog/Post'],
    ['https://example.com/', 'https://example.com/'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com:443/a#section', 'https://example.com/a'],
    ['https://example.com/a?utm_source=x&b=2&a=1&gclid=z', 'https://example.com/a?a=1&b=2'],
    ['https://example.com//a//b/', 'https://example.com/a/b'],
  ])('%s -> %s', (input, out) => expect(normalizePageUrl(input)).toBe(out));

  it('rejects non-http urls', () => {
    expect(normalizePageUrl('javascript:alert(1)')).toBeNull();
    expect(normalizePageUrl('not a url')).toBeNull();
  });
});

describe('propertyCoversHost', () => {
  it('domain properties cover subdomains', () => {
    expect(propertyCoversHost('sc-domain:example.com', 'example.com')).toBe(true);
    expect(propertyCoversHost('sc-domain:example.com', 'blog.example.com')).toBe(true);
    expect(propertyCoversHost('sc-domain:example.com', 'notexample.com')).toBe(false);
  });
  it('URL-prefix properties require the exact host', () => {
    expect(propertyCoversHost('https://www.example.com/', 'www.example.com')).toBe(true);
    expect(propertyCoversHost('https://www.example.com/', 'example.com')).toBe(false);
  });
});

describe('aggregate', () => {
  it('merges URL variants with impression-weighted position', () => {
    const rows = aggregate(
      [
        { keys: ['https://e.com/a/'], clicks: 10, impressions: 1000, ctr: 0.01, position: 8 },
        { keys: ['https://e.com/a?utm_medium=x'], clicks: 2, impressions: 200, ctr: 0.01, position: 2 },
      ],
      false,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ page: 'https://e.com/a', query: '', clicks: 12, impressions: 1200, ctr: 0.01 });
    expect(rows[0]!.position).toBeCloseTo(7, 5); // (8*1000 + 2*200) / 1200
  });

  it('drops rows with invalid URLs or empty queries', () => {
    const rows = aggregate(
      [
        { keys: ['not-a-url', 'q'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
        { keys: ['https://e.com/a', ''], clicks: 1, impressions: 1, ctr: 1, position: 1 },
      ],
      true,
    );
    expect(rows).toHaveLength(0);
  });
});
