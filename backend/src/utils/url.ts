import { isIP } from 'node:net';
import { AppError } from './errors.js';

/**
 * Validates and normalizes a website base URL to its origin.
 * Network-level SSRF protection (DNS resolution, private ranges) lives in the crawler fetcher;
 * this rejects obviously unsafe hosts at input time.
 */
export function normalizeBaseUrl(input: string): { baseUrl: string; hostname: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('VALIDATION_ERROR', 'Only http and https URLs are allowed');
  }
  if (url.username || url.password) throw new AppError('VALIDATION_ERROR', 'URL must not contain credentials');
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new AppError('VALIDATION_ERROR', 'Only default ports are allowed');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(hostname.replace(/^\[|\]$/g, '')) || !hostname.includes('.') || /(^|\.)(localhost|local|internal)$/.test(hostname)) {
    throw new AppError('VALIDATION_ERROR', 'URL must use a public domain name');
  }
  return { baseUrl: `${url.protocol}//${hostname}`, hostname };
}

/** True if `candidate` is on the website host (allowing the www./apex variant). */
export function isSameSite(candidate: string, hostname: string): boolean {
  try {
    const h = new URL(candidate).hostname.toLowerCase();
    const strip = (x: string) => x.replace(/^www\./, '');
    return strip(h) === strip(hostname);
  } catch {
    return false;
  }
}

const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|ref)$/i;

/**
 * Canonical form used to join GSC `page` values with crawled ContentPage URLs:
 * lowercase scheme/host, no fragment, no tracking params, sorted query, no trailing slash (except root).
 * Returns null for non-http(s) or unparsable input.
 */
export function normalizePageUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** Does a Search Console property cover this website hostname? */
export function propertyCoversHost(siteUrl: string, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  try {
    return new URL(siteUrl).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}
