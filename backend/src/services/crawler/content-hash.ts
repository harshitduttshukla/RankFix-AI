import { sha256 } from '../../utils/crypto.js';
import type { ExtractedPage } from './extract.js';

/** JSON with sorted object keys, so equal content always serializes identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Hash of what matters for SEO/content: metadata, heading structure, section content, in-content links and images.
 * Deliberately excludes raw HTML (nonces, timestamps, asset hashes) and site chrome so cosmetic churn
 * doesn't create new versions.
 */
export function contentHash(page: ExtractedPage): string {
  return sha256(
    stableStringify({
      title: page.title,
      metaDescription: page.metaDescription,
      canonicalUrl: page.canonicalUrl,
      robotsMeta: page.robotsMeta,
      language: page.language,
      headings: page.headings.map((h) => [h.level, h.text]),
      sections: page.sections.map((s) => ({ heading: s.heading, level: s.level, blocks: s.blocks })),
      links: page.links.filter((l) => l.inContent).map((l) => [l.targetUrl, l.anchorText, l.rel]),
      images: page.images.filter((i) => i.inContent).map((i) => [i.src, i.alt]),
      jsonLd: page.jsonLd.map((j) => j.data),
    }),
  );
}
