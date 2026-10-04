import { normalizePageUrl } from '../../utils/url.js';

const ASSET_EXT =
  /\.(pdf|zip|gz|tgz|rar|7z|tar|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4a|mov|avi|wmv|webm|ogg|wav|flac|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|eot|exe|dmg|apk|rss|atom)$/i;

export interface CrawlScope {
  /** Same website host (apex/www variants), http(s). Used for redirects and link classification. */
  isSameSite(url: string): boolean;
  /** Should this URL become a ContentPage candidate? (same site + blog prefix + not an asset). */
  isCandidate(url: string): boolean;
}

export function createScope(website: { hostname: string; blogPathPrefix: string | null }): CrawlScope {
  const base = website.hostname.toLowerCase().replace(/^www\./, '');
  const prefix = website.blogPathPrefix?.replace(/\/+$/, '') || null;

  const parse = (raw: string) => {
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch {
      return null;
    }
  };

  const isSameSite = (raw: string) => {
    const u = parse(raw);
    return Boolean(u && u.hostname.toLowerCase().replace(/^www\./, '') === base);
  };

  return {
    isSameSite,
    isCandidate(raw) {
      const u = parse(raw);
      if (!u || !isSameSite(raw)) return false;
      if (ASSET_EXT.test(u.pathname)) return false;
      if (prefix && u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`)) return false;
      return true;
    },
  };
}

/** Normalize + dedupe + scope filter, preserving first-seen order. */
export function filterCandidates(urls: Iterable<string>, scope: CrawlScope): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const n = normalizePageUrl(raw);
    if (!n || seen.has(n) || !scope.isCandidate(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
