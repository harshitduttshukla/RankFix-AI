import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../src/services/crawler/content-hash.js';
import { extractPage, type ExtractOptions } from '../src/services/crawler/extract.js';
import { createScope } from '../src/services/crawler/scope.js';

const html = readFileSync(new URL('./fixtures/blog-post.html', import.meta.url), 'utf8');
const scope = createScope({ hostname: 'acme.test', blogPathPrefix: null });
const opts: ExtractOptions = { pageUrl: 'https://acme.test/blog/react', isSameSite: scope.isSameSite, minContentWords: 40, userAgentToken: 'BlogPilotBot' };
const page = extractPage(html, opts);

describe('metadata extraction', () => {
  it('extracts title, description, canonical, language, robots', () => {
    expect(page.title).toBe('Complete React Guide | Acme Blog');
    expect(page.metaDescription).toBe('Learn React from scratch: components, hooks and state.');
    expect(page.canonicalUrl).toBe('https://acme.test/guides/react'); // resolved, stored separately from the URL
    expect(page.language).toBe('en-US');
    expect(page.robotsMeta).toBe('index, follow');
    expect(page.noindex).toBe(false);
  });

  it('extracts OpenGraph/Twitter, charset and viewport', () => {
    expect(page.seoMeta.og).toEqual({ title: 'Complete React Guide', image: 'https://acme.test/img/og-react.png' });
    expect(page.seoMeta.twitter).toEqual({ card: 'summary_large_image' });
    expect(page.seoMeta.charset).toBe('utf-8');
    expect(page.seoMeta.viewport).toContain('width=device-width');
  });

  it('parses JSON-LD, collects @types, and counts invalid blocks without failing', () => {
    expect(page.jsonLd).toHaveLength(2);
    expect(page.jsonLd[0]!.types).toEqual(['Article']);
    expect(page.jsonLd[1]!.types).toEqual(['BreadcrumbList', 'WebPage', 'FAQPage']);
    expect(page.invalidJsonLd).toBe(1);
  });

  it('detects noindex from meta robots, bot-specific meta, or X-Robots-Tag', () => {
    expect(extractPage('<meta name="robots" content="noindex,follow"><p>x</p>', opts).noindex).toBe(true);
    expect(extractPage('<meta name="blogpilotbot" content="none"><p>x</p>', opts).noindex).toBe(true);
    expect(extractPage('<p>x</p>', { ...opts, xRobotsTag: 'noindex' }).noindex).toBe(true);
  });
});

describe('structure extraction', () => {
  it('chooses the article as main content', () => {
    expect(page.container).toBe('article');
    expect(page.bodyText).not.toContain('cookies');
    expect(page.bodyText).not.toContain('Buy our course');
    expect(page.bodyText).not.toContain('Related: Vue guide');
    expect(page.bodyText).not.toContain('Privacy');
  });

  it('extracts headings with level and order', () => {
    expect(page.headings).toEqual([
      { level: 1, text: 'Complete React Guide', order: 0 },
      { level: 2, text: 'What is React?', order: 1 },
      { level: 2, text: 'Why use React?', order: 2 },
      { level: 3, text: 'React Components', order: 3 },
    ]);
    expect(page.h1).toBe('Complete React Guide');
  });

  it('represents the article as ordered sections with typed blocks', () => {
    expect(page.sections.map((s) => [s.key, s.heading, s.level])).toEqual([
      ['s0-complete-react-guide', 'Complete React Guide', 1],
      ['s1-what-is-react', 'What is React?', 2],
      ['s2-why-use-react', 'Why use React?', 2],
      ['s3-react-components', 'React Components', 3],
    ]);
    const what = page.sections[1]!;
    expect(what.blocks.map((b) => b.type)).toEqual(['p', 'p', 'figure']);
    expect(what.blocks[0]!.text).toMatch(/^React is a JavaScript library/);
    expect(what.blocks[2]).toMatchObject({ type: 'figure', text: 'How React renders', src: 'https://acme.test/img/react-arch.png' });
    expect(what.html).toContain('<h2>What is React?</h2>');

    const why = page.sections[2]!;
    expect(why.blocks[0]).toEqual({ type: 'ul', text: 'Declarative views\nComponent reuse\nHuge ecosystem', items: ['Declarative views', 'Component reuse', 'Huge ecosystem'] });
    expect(why.blocks[1]).toMatchObject({ type: 'p', text: expect.stringMatching(/^Teams adopt React/) }); // <div> paragraph
    expect(page.sections[3]!.blocks[0]).toMatchObject({ type: 'table', items: ['Type | Use', 'Function | Most cases'] });
  });

  it('puts content before the first heading in an intro section', () => {
    const p = extractPage('<main><p>Intro words here for the page.</p><h2>Next</h2><p>Body text of the next part.</p></main>', opts);
    expect(p.sections.map((s) => [s.heading, s.level])).toEqual([[null, 0], ['Next', 2]]);
    expect(p.sections[0]!.key).toBe('s0-intro');
  });

  it('uses a page H1 that sits outside the content container', () => {
    const p = extractPage(
      `<body><div class="hero"><h1>Outside Title</h1></div><main>${'<p>Lots of real content words in this paragraph here. </p>'.repeat(12)}</main></body>`,
      opts,
    );
    expect(p.container).toBe('main');
    expect(p.headings[0]).toEqual({ level: 1, text: 'Outside Title', order: 0 });
    expect(p.sections[0]!.heading).toBe('Outside Title');
  });

  it('does not treat a listing page with many articles as one post', () => {
    const card = (i: number) => `<article><h2>Post ${i}</h2><p>Short teaser text for post number ${i} goes here.</p></article>`;
    const p = extractPage(`<main>${[1, 2, 3, 4, 5].map(card).join('')}</main>`, { ...opts, minContentWords: 10 });
    expect(p.container).toBe('main');
    expect(p.headings).toHaveLength(5);
  });

  it('falls back to body without header/nav/footer when there is no semantic container', () => {
    const p = extractPage(
      `<body><header><a href="/">Logo</a> Site tagline here</header><div><h2>Title</h2><p>${'word '.repeat(60)}</p></div><footer>Footer text © 2026</footer></body>`,
      opts,
    );
    expect(p.container).toBe('body');
    expect(p.bodyText).not.toContain('tagline');
    expect(p.bodyText).not.toContain('Footer');
  });
});

describe('links and images', () => {
  it('normalizes links, strips fragments, classifies internal/external and in-content', () => {
    const byTarget = (t: string) => page.links.filter((l) => l.targetUrl === t);
    expect(byTarget('https://acme.test/blog/components')).toEqual([
      { targetUrl: 'https://acme.test/blog/components', anchorText: 'components', isInternal: true, inContent: true, rel: [], nofollow: false },
    ]);
    expect(byTarget('https://react.dev/')[0]).toMatchObject({ isInternal: false, inContent: true, rel: ['nofollow', 'noopener'], nofollow: true });
    expect(byTarget('https://acme.test/blog')[0]).toMatchObject({ isInternal: true, inContent: false }); // nav
    expect(byTarget('https://acme.test/blog/vue')[0]).toMatchObject({ inContent: false }); // .related inside the article
    expect(page.links.some((l) => l.targetUrl.startsWith('mailto:'))).toBe(false);
  });

  it('extracts images with alt (null when missing, empty when decorative) and dimensions', () => {
    const img = (src: string) => page.images.find((i) => i.src === `https://acme.test/img/${src}`);
    expect(img('react-arch.png')).toEqual({ src: 'https://acme.test/img/react-arch.png', alt: 'React architecture', title: null, width: 800, height: 400, inContent: true });
    expect(img('no-alt.png')!.alt).toBeNull();
    expect(img('decorative.png')!.alt).toBe('');
  });

  it('resolves lazy-loaded images and respects <base href>', () => {
    const p = extractPage('<base href="https://cdn.acme.test/assets/"><main><img data-src="lazy.png" alt="x"></main>', opts);
    expect(p.images[0]!.src).toBe('https://cdn.acme.test/assets/lazy.png');
  });
});

describe('content quality and hashing', () => {
  it('marks a JavaScript app shell as insufficient', () => {
    const shell = extractPage('<html><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src="/app.js"></script></body></html>', opts);
    expect(shell.quality).toEqual({ sufficient: false, appShell: true, reason: 'Page looks like a JavaScript application shell' });
  });

  it('marks a normal article as sufficient', () => {
    expect(page.quality.sufficient).toBe(true);
    expect(page.wordCount).toBeGreaterThan(40);
  });

  it('hash ignores cosmetic HTML churn but changes when content changes', () => {
    const noisy = html.replace('window.analytics = {}', 'window.analytics = {nonce: "abc123"}').replace('class="site-header"', 'class="site-header v2"');
    expect(contentHash(extractPage(noisy, opts))).toBe(contentHash(page));
    const edited = html.replace('released as open source in 2013', 'released as open source in May 2013');
    expect(contentHash(extractPage(edited, opts))).not.toBe(contentHash(page));
    const retitled = html.replace('<title>  Complete React Guide | Acme Blog </title>', '<title>React Guide 2026</title>');
    expect(contentHash(extractPage(retitled, opts))).not.toBe(contentHash(page));
  });
});
