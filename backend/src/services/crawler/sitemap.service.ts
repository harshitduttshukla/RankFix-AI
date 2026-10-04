import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import type { Fetcher } from './fetcher.js';
import { decodeBody } from './safe-fetch.js';

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

export interface SitemapResult {
  entries: SitemapEntry[];
  filesRead: string[];
  errors: { url: string; message: string }[];
  truncated: boolean;
}

export interface ParsedSitemap {
  kind: 'index' | 'urlset' | 'text' | 'unknown';
  locs: SitemapEntry[];
}

const MAX_DECOMPRESSED = 50 * 1024 * 1024;

/** Parses one sitemap document (XML urlset, XML sitemap index, or plain-text list). */
export function parseSitemap(body: Buffer, contentType = ''): ParsedSitemap {
  let buf = body;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED });
  const text = decodeBody(buf, contentType).trim();

  if (!text.startsWith('<')) {
    const locs = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l))
      .map((url) => ({ url, lastmod: null }));
    return { kind: locs.length ? 'text' : 'unknown', locs };
  }

  const $ = cheerio.load(text, { xml: true });
  const pick = (selector: string) =>
    $(selector)
      .toArray()
      .map((el) => ({
        url: $(el).children('loc').first().text().trim(),
        lastmod: $(el).children('lastmod').first().text().trim() || null,
      }))
      .filter((e) => e.url);

  if ($('sitemapindex').length) return { kind: 'index', locs: pick('sitemapindex > sitemap') };
  if ($('urlset').length) return { kind: 'urlset', locs: pick('urlset > url') };
  return { kind: 'unknown', locs: [] };
}

/** Default sitemap locations tried when robots.txt declares none. */
export const defaultSitemapUrls = (origin: string) => [new URL('/sitemap.xml', origin).toString(), new URL('/sitemap_index.xml', origin).toString()];

/**
 * Reads sitemap files breadth-first, following sitemap indexes. Only same-site sitemap files are read.
 * A broken sitemap file is recorded and skipped; it does not fail discovery.
 */
export async function readSitemaps(
  startUrls: string[],
  fetcher: Fetcher,
  opts: { isSameSite: (url: string) => boolean; maxFiles: number; maxUrls: number },
): Promise<SitemapResult> {
  const queue = [...new Set(startUrls)].filter(opts.isSameSite);
  const seen = new Set(queue);
  const result: SitemapResult = { entries: [], filesRead: [], errors: [], truncated: false };

  while (queue.length && result.filesRead.length < opts.maxFiles) {
    const url = queue.shift()!;
    try {
      const res = await fetcher(url, 'xml');
      if (res.status < 200 || res.status >= 300) {
        result.errors.push({ url, message: `HTTP ${res.status}` });
        continue;
      }
      const parsed = parseSitemap(res.body, res.contentType);
      result.filesRead.push(url);
      if (parsed.kind === 'index') {
        for (const child of parsed.locs) {
          if (!seen.has(child.url) && opts.isSameSite(child.url)) {
            seen.add(child.url);
            queue.push(child.url);
          }
        }
      } else if (parsed.kind === 'unknown') {
        result.errors.push({ url, message: 'Not a sitemap' });
      } else {
        for (const e of parsed.locs) {
          if (result.entries.length >= opts.maxUrls) {
            result.truncated = true;
            break;
          }
          result.entries.push(e);
        }
      }
    } catch (err) {
      result.errors.push({ url, message: (err as Error).message.slice(0, 300) });
    }
  }
  if (queue.length) result.truncated = true;
  return result;
}
