import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { normalizePageUrl } from '../../utils/url.js';

export type BlockType = 'p' | 'ul' | 'ol' | 'blockquote' | 'table' | 'pre' | 'dl' | 'figure' | 'img';

export interface ContentBlock {
  type: BlockType;
  text: string;
  items?: string[]; // list items / table rows
  src?: string; // images
  alt?: string | null;
}

export interface ExtractedSection {
  key: string;
  order: number;
  heading: string | null;
  level: number; // 0 = intro before the first heading
  blocks: ContentBlock[];
  html: string;
  text: string;
  wordCount: number;
}

export interface ExtractedHeading {
  level: number;
  text: string;
  order: number;
}

export interface ExtractedLink {
  targetUrl: string;
  anchorText: string;
  isInternal: boolean;
  inContent: boolean;
  rel: string[];
  nofollow: boolean;
}

export interface ExtractedImage {
  src: string;
  alt: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  inContent: boolean;
}

export interface SeoMeta {
  og: Record<string, string>;
  twitter: Record<string, string>;
  charset: string | null;
  viewport: string | null;
}

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  language: string | null;
  robotsMeta: string | null;
  noindex: boolean;
  seoMeta: SeoMeta;
  h1: string | null;
  headings: ExtractedHeading[];
  sections: ExtractedSection[];
  bodyHtml: string;
  bodyText: string;
  wordCount: number;
  links: ExtractedLink[];
  images: ExtractedImage[];
  jsonLd: { types: string[]; data: unknown }[];
  invalidJsonLd: number;
  container: string;
  quality: { sufficient: boolean; appShell: boolean; reason: string | null };
}

export interface ExtractOptions {
  pageUrl: string;
  isSameSite: (url: string) => boolean;
  minContentWords: number;
  userAgentToken?: string;
  xRobotsTag?: string | null;
  contentType?: string;
}

const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK = new Set(['p', 'ul', 'ol', 'blockquote', 'table', 'pre', 'dl', 'figure']);
const STRUCTURAL = new Set([
  ...HEADING, ...BLOCK, 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'li', 'img', 'br', 'hr', 'form',
]);

const NOISE = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'object', 'embed', 'link', 'meta', 'button', 'input', 'select', 'textarea',
  '[hidden]', '[aria-hidden="true"]', '[style*="display:none"]', '[style*="display: none"]',
  '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]', '[class*="gdpr" i]',
  '[class*="advert" i]', '[id*="advert" i]', '[class~="ad"]', '[class~="ads"]', '[data-ad]', 'ins.adsbygoogle', '[id^="google_ads"]',
].join(',');

const CONTENT_SELECTORS = [
  '[itemprop="articleBody"]', '.entry-content', '.post-content', '.article-content', '.article-body', '.post-body', '.blog-post',
  '.single-post', '.post', '#content', '.content', '#main',
];

const IN_CONTAINER_NOISE = [
  'nav', 'aside', 'form', '[role="navigation"]', '[role="complementary"]', '.share', '.sharing', '.social', '.related',
  '.related-posts', '.comments', '#comments', '.newsletter', '.author-box',
].join(',');

const APP_SHELL = '#root, #__next, #app, #___gatsby, #__nuxt, [ng-version], [data-reactroot], app-root';

export const normText = (s: string) => s.replace(/\s+/g, ' ').trim();
export const countWords = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';

function absolute(raw: string | undefined, base: string): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || /^(javascript|mailto|tel|data|sms|about|blob):/i.test(v) || v.startsWith('#')) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function metaContent($: CheerioAPI, attr: 'name' | 'property' | 'http-equiv', key: string): string | null {
  const el = $(`meta[${attr}]`)
    .toArray()
    .find((m) => ($(m).attr(attr) ?? '').toLowerCase() === key);
  const v = el ? normText($(el).attr('content') ?? '') : '';
  return v || null;
}

/** Collects every @type in a JSON-LD value (top level and @graph). */
function jsonLdTypes(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 3 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v) => jsonLdTypes(v, out, depth + 1));
    return out;
  }
  const obj = value as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') out.add(t);
  if (Array.isArray(t)) t.filter((x): x is string => typeof x === 'string').forEach((x) => out.add(x));
  if (obj['@graph']) jsonLdTypes(obj['@graph'], out, depth + 1);
  return out;
}

function extractJsonLd($: CheerioAPI) {
  const blocks: { types: string[]; data: unknown }[] = [];
  let invalid = 0;
  $('script')
    .filter((_, el) => /application\/ld\+json/i.test($(el).attr('type') ?? ''))
    .each((_, el) => {
      const raw = ($(el).html() ?? '').replace(/^\s*(<!--|<!\[CDATA\[)/, '').replace(/(-->|\]\]>)\s*$/, '').trim();
      if (!raw) return;
      if (raw.length > 200_000 || blocks.length >= 20) {
        invalid++;
        return;
      }
      try {
        const data: unknown = JSON.parse(raw);
        blocks.push({ types: [...jsonLdTypes(data)], data });
      } catch {
        invalid++;
      }
    });
  return { blocks, invalid };
}

function wordsOf($: CheerioAPI, el: Cheerio<AnyNode>) {
  return countWords(el.text());
}

/** Picks the main content element. Returns the element and a label for debugging. */
function chooseContainer($: CheerioAPI): { el: Cheerio<Element>; label: string } {
  const body = $('body').length ? $('body') : $.root().children().first();
  const bodyWords = Math.max(1, wordsOf($, body as Cheerio<AnyNode>));
  const goodEnough = (el: Cheerio<Element>) => {
    const w = wordsOf($, el as Cheerio<AnyNode>);
    return w >= 50 || w >= bodyWords * 0.3;
  };

  const articles = $('article').toArray();
  if (articles.length) {
    const scored = articles.map((a) => ({ a, w: wordsOf($, $(a)) })).sort((x, y) => y.w - x.w);
    const total = scored.reduce((s, x) => s + x.w, 0);
    const best = scored[0]!;
    // Many similar-sized <article>s = a listing page, not one post.
    const isListing = articles.length > 3 && best.w < total * 0.5;
    if (!isListing && goodEnough($(best.a))) return { el: $(best.a), label: 'article' };
  }

  for (const sel of ['main', '[role="main"]', ...CONTENT_SELECTORS]) {
    const el = $(sel).first() as Cheerio<Element>;
    if (el.length && goodEnough(el)) return { el, label: sel };
  }
  return { el: body as Cheerio<Element>, label: 'body' };
}

interface WalkState {
  sections: { heading: string | null; level: number; blocks: ContentBlock[]; htmlParts: string[] }[];
  headings: ExtractedHeading[];
}

function blockFrom($: CheerioAPI, el: Element, base: string): ContentBlock | null {
  const tag = el.tagName.toLowerCase() as BlockType;
  const $el = $(el);
  if (tag === 'ul' || tag === 'ol') {
    const items = $el.children('li').toArray().map((li) => normText($(li).text())).filter(Boolean);
    return items.length ? { type: tag, text: items.join('\n'), items } : null;
  }
  if (tag === 'table') {
    const items = $el
      .find('tr')
      .toArray()
      .map((tr) => $(tr).children('th,td').toArray().map((c) => normText($(c).text())).join(' | '))
      .filter((r) => r.replace(/[|\s]/g, ''));
    return items.length ? { type: 'table', text: items.join('\n'), items } : null;
  }
  if (tag === 'figure') {
    const img = $el.find('img').first();
    const caption = normText($el.find('figcaption').text());
    const src = img.length ? absolute(img.attr('src') ?? img.attr('data-src'), base) : null;
    if (!src && !caption) return null;
    return { type: 'figure', text: caption, ...(src ? { src, alt: img.attr('alt') ?? null } : {}) };
  }
  if (tag === 'pre') {
    const text = ($el.text() ?? '').trim();
    return text ? { type: 'pre', text } : null;
  }
  const text = normText($el.text());
  return text ? { type: (tag === 'blockquote' || tag === 'dl' ? tag : 'p') as BlockType, text } : null;
}

function walk($: CheerioAPI, node: AnyNode, state: WalkState, base: string) {
  const current = () => state.sections[state.sections.length - 1]!;
  for (const child of $(node).contents().toArray()) {
    if (child.type === 'text') {
      const t = normText((child as unknown as { data: string }).data);
      if (countWords(t) >= 3) {
        current().blocks.push({ type: 'p', text: t });
        current().htmlParts.push(`<p>${$('<i>').text(t).html()}</p>`);
      }
      continue;
    }
    if (child.type !== 'tag') continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (HEADING.has(tag)) {
      const text = normText($(el).text());
      if (!text) continue;
      const level = Number(tag[1]);
      state.headings.push({ level, text, order: state.headings.length });
      state.sections.push({ heading: text, level, blocks: [], htmlParts: [$.html(el)] });
      continue;
    }
    if (BLOCK.has(tag)) {
      // A block that wraps headings (e.g. <figure><h2>) is walked instead of flattened.
      if ($(el).find('h1,h2,h3,h4,h5,h6').length) {
        walk($, el, state, base);
        continue;
      }
      const block = blockFrom($, el, base);
      if (block) {
        current().blocks.push(block);
        current().htmlParts.push($.html(el));
      }
      continue;
    }
    if (tag === 'img') {
      const src = absolute($(el).attr('src') ?? $(el).attr('data-src'), base);
      if (src) {
        current().blocks.push({ type: 'img', text: '', src, alt: $(el).attr('alt') ?? null });
        current().htmlParts.push($.html(el));
      }
      continue;
    }
    // Container with no structural descendants and real text = a paragraph written as <div>/<span>.
    const hasStructure = $(el)
      .find('*')
      .toArray()
      .some((d) => STRUCTURAL.has((d as Element).tagName.toLowerCase()));
    if (!hasStructure && !STRUCTURAL.has(tag)) {
      const text = normText($(el).text());
      if (countWords(text) >= 3) {
        current().blocks.push({ type: 'p', text });
        current().htmlParts.push($.html(el));
      }
      continue;
    }
    if (!hasStructure && (tag === 'div' || tag === 'section')) {
      const text = normText($(el).text());
      if (text) {
        current().blocks.push({ type: 'p', text });
        current().htmlParts.push($.html(el));
      }
      continue;
    }
    walk($, el, state, base);
  }
}

/** Parses HTML into a structured page. Pure: no I/O. */
export function extractPage(html: string, opts: ExtractOptions): ExtractedPage {
  const $ = cheerio.load(html);
  const base = absolute($('base[href]').attr('href'), opts.pageUrl) ?? opts.pageUrl;

  // ── head metadata (before any cleanup) ──
  const title = normText($('head title').first().text() || $('title').first().text()) || null;
  const metaDescription = metaContent($, 'name', 'description');
  const canonicalHref = $('link[rel]')
    .toArray()
    .find((l) => ($(l).attr('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  const canonicalUrl = canonicalHref ? absolute($(canonicalHref).attr('href'), base) : null;
  const language = normText($('html').attr('lang') ?? '') || metaContent($, 'http-equiv', 'content-language');
  const robotsParts = [metaContent($, 'name', 'robots'), opts.userAgentToken ? metaContent($, 'name', opts.userAgentToken.toLowerCase()) : null, opts.xRobotsTag ?? null].filter(
    (x): x is string => Boolean(x),
  );
  const robotsMeta = robotsParts.length ? robotsParts.join(', ') : null;
  const noindex = /\b(noindex|none)\b/i.test(robotsMeta ?? '');

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  for (const key of ['title', 'description', 'image', 'url', 'type']) {
    const o = metaContent($, 'property', `og:${key}`);
    if (o) og[key] = key === 'image' || key === 'url' ? (absolute(o, base) ?? o) : o;
  }
  for (const key of ['card', 'title', 'description', 'image']) {
    const t = metaContent($, 'name', `twitter:${key}`) ?? metaContent($, 'property', `twitter:${key}`);
    if (t) twitter[key] = key === 'image' ? (absolute(t, base) ?? t) : t;
  }
  const charset = ($('meta[charset]').attr('charset') ?? opts.contentType?.match(/charset=([\w-]+)/i)?.[1] ?? null)?.toLowerCase() ?? null;
  const viewport = metaContent($, 'name', 'viewport');

  const { blocks: jsonLd, invalid: invalidJsonLd } = extractJsonLd($);

  // ── app-shell signal (before noise removal strips <noscript>) ──
  const noscriptAsksForJs = /enable javascript|requires javascript|javascript is (disabled|required)/i.test($('noscript').text());
  const hasShellRoot = $(APP_SHELL).length > 0;

  // ── cleanup: never remove the structural roots themselves ──
  $(NOISE)
    .filter((_, el) => !['html', 'body', 'main', 'article'].includes((el as Element).tagName?.toLowerCase()) && $(el).find('h1').length === 0)
    .remove();

  // ── main content ──
  const { el: container, label } = chooseContainer($);
  const content = container.clone();
  content.find(IN_CONTAINER_NOISE).remove();
  if (label === 'body' || label === 'main' || label === '[role="main"]') {
    // Site chrome (mirrored in the in-content link/image filter below). A <header> inside an <article> holds the title/byline, so keep those.
    content.find('header, footer').filter((_, el) => $(el).closest('article').length === 0).remove();
  }

  const firstH1 = $('h1')
    .toArray()
    .find((h) => $(h).closest('nav, footer').length === 0 && normText($(h).text()));
  const pageH1 = firstH1 ? normText($(firstH1).text()) : '';
  const contentHasH1 = content.find('h1').length > 0;

  const state: WalkState = { sections: [{ heading: null, level: 0, blocks: [], htmlParts: [] }], headings: [] };
  if (pageH1 && !contentHasH1) {
    state.headings.push({ level: 1, text: pageH1, order: 0 });
    state.sections = [{ heading: pageH1, level: 1, blocks: [], htmlParts: [] }];
  }
  for (const root of content.toArray()) walk($, root, state, base);

  const sections: ExtractedSection[] = state.sections
    .filter((s) => s.heading !== null || s.blocks.length > 0)
    .map((s, order) => {
      const text = s.blocks.map((b) => b.text).filter(Boolean).join('\n\n');
      return {
        key: `s${order}-${s.heading ? slug(s.heading) : 'intro'}`,
        order,
        heading: s.heading,
        level: s.level,
        blocks: s.blocks,
        html: s.htmlParts.join('\n'),
        text,
        wordCount: countWords([s.heading ?? '', text].join(' ')),
      };
    });

  const bodyText = sections.map((s) => [s.heading, s.text].filter(Boolean).join('\n')).join('\n\n');
  const wordCount = countWords(bodyText);

  // ── links & images over the whole cleaned page; flag what sits in the main content ──
  const stripChrome = label === 'body' || label === 'main' || label === '[role="main"]';
  const contentNodes = new Set<AnyNode>(
    container
      .find('a, img')
      .filter((_, el) => {
        if ($(el).closest(IN_CONTAINER_NOISE).length) return false;
        if (stripChrome && $(el).closest('header, footer').filter((__, h) => $(h).closest('article').length === 0).length) return false;
        return true;
      })
      .toArray(),
  );
  const links: ExtractedLink[] = [];
  const seenLinks = new Set<string>();
  $('a[href]').each((_, a) => {
    const target = absolute($(a).attr('href'), base);
    if (!target) return;
    const isInternal = opts.isSameSite(target);
    const targetUrl = isInternal ? (normalizePageUrl(target) ?? target) : target;
    const anchorText = (normText($(a).text()) || normText($(a).find('img').attr('alt') ?? '') || normText($(a).attr('aria-label') ?? $(a).attr('title') ?? '')).slice(0, 500);
    const inContent = contentNodes.has(a);
    const key = `${targetUrl}\u0000${anchorText}\u0000${inContent}`;
    if (seenLinks.has(key) || links.length >= 2000) return;
    seenLinks.add(key);
    const rel = ($(a).attr('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    links.push({ targetUrl, anchorText, isInternal, inContent, rel, nofollow: rel.includes('nofollow') });
  });

  const images: ExtractedImage[] = [];
  const seenImages = new Set<string>();
  $('img').each((_, img) => {
    const $img = $(img);
    const srcsetFirst = ($img.attr('srcset') ?? $img.attr('data-srcset') ?? '').split(',')[0]?.trim().split(/\s+/)[0];
    const src = absolute($img.attr('src'), base) ?? absolute($img.attr('data-src') ?? $img.attr('data-lazy-src'), base) ?? absolute(srcsetFirst, base);
    if (!src) return;
    const inContent = contentNodes.has(img);
    const key = `${src}\u0000${inContent}`;
    if (seenImages.has(key) || images.length >= 500) return;
    seenImages.add(key);
    const dim = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
    const alt = $img.attr('alt');
    images.push({
      src,
      alt: alt === undefined ? null : normText(alt),
      title: normText($img.attr('title') ?? '') || null,
      width: dim($img.attr('width')),
      height: dim($img.attr('height')),
      inContent,
    });
  });

  const appShell = (hasShellRoot || noscriptAsksForJs) && wordCount < opts.minContentWords;
  const sufficient = !appShell && wordCount >= opts.minContentWords;

  return {
    title,
    metaDescription,
    canonicalUrl,
    language: language || null,
    robotsMeta,
    noindex,
    seoMeta: { og, twitter, charset, viewport },
    h1: state.headings.find((h) => h.level === 1)?.text ?? null,
    headings: state.headings,
    sections,
    bodyHtml: content.html() ?? '',
    bodyText,
    wordCount,
    links,
    images,
    jsonLd,
    invalidJsonLd,
    container: label,
    quality: {
      sufficient,
      appShell,
      reason: sufficient ? null : appShell ? 'Page looks like a JavaScript application shell' : `Only ${wordCount} words of content found`,
    },
  };
}
