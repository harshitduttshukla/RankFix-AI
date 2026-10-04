# Phase 3: Website Crawler

## 1. Architecture impact

The crawler is a new module inside the existing backend: `src/services/crawler/`. It reuses:
- existing auth and website-access middleware
- the existing Redis connection, plus a new BullMQ queue `website-crawl` processed by the existing worker process
- existing error and logging conventions
- `normalizePageUrl()` from Phase 2, so crawled page URLs match GSC page URLs exactly

Nothing in Phase 1 or Phase 2 is rewritten.

```
POST /websites/:id/crawl ─▶ CrawlJob(PENDING) ─▶ BullMQ website-crawl ─▶ worker
worker: robots.txt ─▶ sitemaps (or link discovery) ─▶ scope/robots/prefix filter ─▶ page pool
page:   safeFetch (SSRF-pinned) ─▶ Cheerio extract ─▶ enough content? ─no─▶ Playwright render ─▶ extract
        ─▶ hash ─▶ unchanged? (touch page) : (new ContentPageVersion + sections/links/images/JSON-LD) ─▶ CrawlPageResult
```

## 2. Prisma changes

| Model | Change |
|---|---|
| `ContentPage` | Adds `redirectedTo`, `noindex`, `lastCrawlJobId`. `PageStatus` gains `REDIRECTED` and `ERROR`. The URL stays the stable identity, with one row per `(websiteId, url)`. |
| `ContentPageVersion` | Adds `canonicalUrl`, `language`, `robotsMeta`, `seoMeta` (og/twitter/charset/viewport), `sections` (JSONB), `rawHtml` (original HTTP body), `renderedHtml` (Playwright DOM), `extractionMethod` (`HTTP_CHEERIO`/`PLAYWRIGHT`), `crawlerVersion`, `httpStatus`, `crawlJobId`. Drops the unused `internalLinks` JSON, which is replaced by `PageLink`. |
| `PageSection` (new) | One row per heading-delimited section: `sectionKey`, `order`, `heading`, `level`, `html`, `text`, `wordCount`, plus `blocks` JSON (p/ul/ol/table/…). This gives later phases a stable target like "section under H2 *What is React?*". |
| `PageLink` (new) | Per version: `targetUrl`, `anchorText`, `isInternal`, `inContent`, `rel[]`, `nofollow`. |
| `PageImage` (new) | Per version: `src`, `alt` (null = missing, "" = decorative), `title`, `width`, `height`, `inContent`. |
| `PageStructuredData` (new) | Per version: one row per valid JSON-LD block, with `types[]` and `data`. Invalid blocks are counted on the version and never fail the crawl. |
| `CrawlJob` (new) | Fields: status, counters, config snapshot, sitemaps used, discovery method, error, cancellation request, start/end timestamps. |
| `CrawlPageResult` (new) | Per URL per crawl: outcome, HTTP status, final URL, method, duration, error code/message, pageId/versionId. |

All new tables carry `organizationId`, plus `projectId`/`websiteId` where they're queried directly. Child rows only exist for versions that were actually created; unchanged pages add nothing.

## 3. Crawler module

```
services/crawler/
  config.ts            env-driven limits (pages, concurrency, delay, timeouts, size, Playwright)
  ip-policy.ts         private/reserved IPv4+IPv6 ranges (net.BlockList), v4-mapped v6 handling
  safe-fetch.ts        undici Agent whose connect-time DNS lookup rejects private IPs (DNS-rebinding safe),
                       manual redirects (max 5, each hop re-validated + scope-checked), byte cap, timeout,
                       content-type gate, charset decoding, User-Agent BlogPilotBot/1.0
  robots.service.ts    loadRobotsTxt / isAllowed / getSitemaps / crawlDelay (robots-parser)
  sitemap.service.ts   sitemap + sitemap index (recursive, gzip), limits, lastmod
  scope.ts             host (www/apex) + optional blogPathPrefix + asset-extension filter
  extract.ts           Cheerio: metadata, SEO meta, headings, main-content detection, sections,
                       links, images, JSON-LD, word count, content-quality verdict
  content-hash.ts      SHA-256 over canonical JSON of meaningful fields (not raw HTML)
  renderer.ts          Playwright fallback: one browser per crawl, 1 page at a time, request routing
                       blocks private hosts + images/media/fonts, hard timeouts, always closed
  crawl-runner.ts      the pipeline: discovery, pool, cancellation, duration cap, finalize
  page-store.ts        transactional ContentPage/Version/children writes with optimistic versionNo
```

## 4. Crawl state machine

```
PENDING ──▶ RUNNING ──▶ COMPLETED   (no page failures)
   │           ├──────▶ PARTIAL     (some failed, or page/time limit reached)
   │           ├──────▶ FAILED      (discovery impossible, or every page failed, or worker died)
   └──────────▶ CANCELLED ◀─ RUNNING (cancel request checked between pages)
```
- One active (PENDING or RUNNING) crawl per website. A second request returns `409 CONFLICT`.
- At worker startup, any RUNNING crawl older than the duration cap is marked FAILED ("interrupted").

Per-page outcomes:
- `CREATED`: first version stored.
- `UPDATED`: content hash changed, so a new version was stored.
- `UNCHANGED`: same hash, so no version was created.
- `SKIPPED`: robots disallowed, non-HTML, or redirected out of scope.
- `FAILED`: one of `TIMEOUT`, `DNS`, `SSRF_BLOCKED`, `HTTP_4xx/5xx`, `TOO_LARGE`, `REDIRECT_LIMIT`, `RENDER_FAILED`, `NETWORK`.

Effect on `ContentPage`:
- 404/410 → `GONE`
- redirect → `REDIRECTED` + `redirectedTo`
- `noindex` → `EXCLUDED`

Only `ACTIVE` pages will be optimization candidates in Phase 4.

## 5. Extraction structure (stored per version)

```jsonc
{
  "title": "...", "metaDescription": "...", "canonicalUrl": "https://…", "language": "en", "robotsMeta": "index,follow",
  "seoMeta": { "og": {"title","description","image","url"}, "twitter": {...}, "charset": "utf-8", "viewport": "…" },
  "headings": [{ "level": 1, "text": "Complete React Guide", "order": 0 }],
  "sections": [
    { "key": "s0-intro", "order": 0, "heading": null, "level": 0, "blocks": [{ "type": "p", "text": "…" }], "wordCount": 42 },
    { "key": "s1-what-is-react", "order": 1, "heading": "What is React?", "level": 2,
      "blocks": [{ "type": "p", "text": "…" }, { "type": "ul", "items": ["…"] }], "wordCount": 120 }
  ],
  "bodyHtml": "<cleaned main-content HTML>", "bodyText": "…", "wordCount": 1830
}
```
**Main content:** pick the best `<article>` (by text length), else `<main>` or `[role=main]`, else common content containers, else `<body>` minus header/nav/footer/aside. Before choosing, remove script, style, noscript, template, iframe, svg, forms, hidden elements, cookie and consent banners, and ad containers. The raw HTML is always kept separately.

**Playwright fallback** runs when the extracted content has fewer than `CRAWLER_MIN_CONTENT_WORDS` words, or the body looks like an app shell (`#root`, `#__next`, `#app`, or a noscript "enable JavaScript" notice with no content).

## 6. API (all behind requireAuth + requireWebsiteAccess)

| Method & path | Role | Response |
|---|---|---|
| POST `/api/websites/:websiteId/crawl` | EDITOR | `202 CrawlJob` · `409` if one is active |
| GET `/api/websites/:websiteId/crawls` | VIEWER | last 20 `CrawlJob` |
| GET `/api/websites/:websiteId/crawls/:crawlId` | VIEWER | `CrawlJob & { failures: CrawlPageResult[] }` |
| POST `/api/websites/:websiteId/crawls/:crawlId/cancel` | EDITOR | `CrawlJob` |
| GET `/api/websites/:websiteId/pages?status&q&cursor` | VIEWER | `{ items: PageRow[], nextCursor }` |
| GET `/api/websites/:websiteId/pages/:pageId` | VIEWER | page + current version (no raw HTML) + sections, links, images, JSON-LD |
| GET `/api/websites/:websiteId/pages/:pageId/versions` | VIEWER | version list (metadata only) |

## 7. Worker & queue

- **Queue:** `website-crawl`, job data `{ crawlJobId }`, 1 attempt. The crawl itself is resumable, and the per-page records are the durable state. Worker concurrency is 2 crawls.
- **Inside a crawl:**
  - a promise pool of `CRAWLER_CONCURRENCY` pages
  - a delay of max(`CRAWLER_DELAY_MS`, robots `Crawl-delay` capped at 10s) between requests
  - one polite retry on 429/503, honoring `Retry-After` (capped)
  - limits: `CRAWLER_MAX_PAGES`, `CRAWLER_MAX_DURATION_MS`, `CRAWLER_PLAYWRIGHT_MAX_PAGES`
- **Counters** are flushed to `CrawlJob` as pages finish, so the UI can poll progress.

## 8. Testing plan

- **Unit:**
  - URL normalization and scope
  - IP policy (v4, v6, mapped, metadata)
  - robots allow/disallow/sitemaps
  - sitemap and index (including gzip and limits)
  - extraction: title, meta, canonical, headings, sections, links, images, JSON-LD (valid and invalid)
  - main-content detection, content hash, quality verdict
- **Integration:**
  - a local fixture HTTP server, with a test-only fetch policy that allows loopback; the real policy is tested separately
  - timeouts, redirects, size caps, non-HTML
  - the full crawl pipeline: created → unchanged → updated versions
  - failure isolation (PARTIAL), cancellation, 404 → GONE
  - Playwright rendering of a JS-only page
  - API authorization and tenant isolation
  - a BullMQ end-to-end job
- **Manual acceptance:** crawl a real custom website before marking Phase 3 complete.
