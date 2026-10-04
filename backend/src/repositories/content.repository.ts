import type { CrawlOutcome, ExtractionMethod, PageStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import type { ExtractedPage } from '../services/crawler/extract.js';
import type { TenantContext } from '../types/tenant.js';

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;
interface WebsiteRef {
  id: string;
  organizationId: string;
  projectId: string;
}

export interface StoreInput {
  website: WebsiteRef;
  crawlJobId: string;
  url: string;
  httpStatus: number;
  method: ExtractionMethod;
  crawlerVersion: string;
  page: ExtractedPage;
  hash: string;
  rawHtml: string;
  renderedHtml: string | null;
}

export class VersionConflictError extends Error {}

const json = (v: unknown) => v as Prisma.InputJsonValue;

export const contentRepository = {
  /**
   * Upserts the stable ContentPage identity and creates a new version only when the content hash changed.
   * Version numbers advance with an optimistic check, so concurrent writers can't both create "version N".
   */
  async storeCrawledPage(input: StoreInput): Promise<{ outcome: CrawlOutcome; pageId: string; versionId: string }> {
    const { website, page } = input;
    const now = new Date();
    const pageFields = {
      httpStatus: input.httpStatus,
      status: (page.noindex ? 'EXCLUDED' : 'ACTIVE') as PageStatus,
      canonicalUrl: page.canonicalUrl,
      noindex: page.noindex,
      redirectedTo: null,
      lastCrawledAt: now,
      lastCrawlJobId: input.crawlJobId,
    };

    return prisma.$transaction(
      async (tx) => {
        const existing = await tx.contentPage.findUnique({
          where: { websiteId_url: { websiteId: website.id, url: input.url } },
          select: { id: true, currentVersionNo: true, currentVersion: { select: { id: true, contentHash: true } } },
        });
        const row =
          existing ??
          (await tx.contentPage.create({
            data: { organizationId: website.organizationId, projectId: website.projectId, websiteId: website.id, url: input.url, ...pageFields },
            select: { id: true, currentVersionNo: true, currentVersion: { select: { id: true, contentHash: true } } },
          }));

        if (row.currentVersion && row.currentVersion.contentHash === input.hash) {
          await tx.contentPage.update({ where: { id: row.id }, data: pageFields });
          return { outcome: 'UNCHANGED' as const, pageId: row.id, versionId: row.currentVersion.id };
        }

        const versionNo = row.currentVersionNo + 1;
        const version = await tx.contentPageVersion.create({
          data: {
            organizationId: website.organizationId,
            pageId: row.id,
            versionNo,
            source: 'CRAWL',
            title: page.title,
            metaDescription: page.metaDescription,
            canonicalUrl: page.canonicalUrl,
            language: page.language,
            robotsMeta: page.robotsMeta,
            seoMeta: json(page.seoMeta),
            h1: page.h1,
            headings: json(page.headings),
            sections: json(page.sections.map(({ html: _html, ...s }) => s)),
            bodyHtml: page.bodyHtml,
            bodyText: page.bodyText,
            wordCount: page.wordCount,
            contentHash: input.hash,
            rawHtml: input.rawHtml,
            renderedHtml: input.renderedHtml,
            extractionMethod: input.method,
            crawlerVersion: input.crawlerVersion,
            httpStatus: input.httpStatus,
            invalidJsonLd: page.invalidJsonLd,
            crawlJobId: input.crawlJobId,
          },
          select: { id: true },
        });
        const org = website.organizationId;
        const versionId = version.id;
        if (page.sections.length) {
          await tx.pageSection.createMany({
            data: page.sections.map((s) => ({
              organizationId: org,
              versionId,
              sectionKey: s.key,
              order: s.order,
              heading: s.heading,
              level: s.level,
              html: s.html,
              text: s.text,
              wordCount: s.wordCount,
              blocks: json(s.blocks),
            })),
          });
        }
        if (page.links.length) await tx.pageLink.createMany({ data: page.links.map((l) => ({ ...l, organizationId: org, versionId })) });
        if (page.images.length) await tx.pageImage.createMany({ data: page.images.map((i) => ({ ...i, organizationId: org, versionId })) });
        if (page.jsonLd.length) {
          await tx.pageStructuredData.createMany({ data: page.jsonLd.map((j) => ({ organizationId: org, versionId, types: j.types, data: json(j.data) })) });
        }

        const moved = await tx.contentPage.updateMany({
          where: { id: row.id, currentVersionNo: row.currentVersionNo },
          data: { ...pageFields, currentVersionId: versionId, currentVersionNo: versionNo },
        });
        if (moved.count !== 1) throw new VersionConflictError('Page changed concurrently; version not recorded');
        return { outcome: (existing ? 'UPDATED' : 'CREATED') as CrawlOutcome, pageId: row.id, versionId };
      },
      { timeout: 30_000 },
    );
  },

  /** Status-only update for pages we already know (never creates pages for 404s/redirects). */
  async markPage(
    website: WebsiteRef,
    url: string,
    data: { status: PageStatus; httpStatus?: number; redirectedTo?: string | null; crawlJobId: string },
  ) {
    const res = await prisma.contentPage.updateMany({
      where: { websiteId: website.id, organizationId: website.organizationId, url },
      data: {
        status: data.status,
        ...(data.httpStatus !== undefined ? { httpStatus: data.httpStatus } : {}),
        redirectedTo: data.redirectedTo ?? null,
        lastCrawledAt: new Date(),
        lastCrawlJobId: data.crawlJobId,
      },
    });
    return res.count > 0;
  },

  // ── read side (all tenant-scoped) ──

  listPages(scope: Scope, websiteId: string, f: { status?: PageStatus; q?: string; cursor?: string; limit: number }) {
    return prisma.contentPage.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        websiteId,
        ...(f.status ? { status: f.status } : {}),
        ...(f.q ? { OR: [{ url: { contains: f.q, mode: 'insensitive' } }, { currentVersion: { title: { contains: f.q, mode: 'insensitive' } } }] } : {}),
      },
      orderBy: { id: 'asc' },
      take: f.limit + 1,
      ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        url: true,
        status: true,
        httpStatus: true,
        canonicalUrl: true,
        redirectedTo: true,
        noindex: true,
        lastCrawledAt: true,
        currentVersionNo: true,
        currentVersion: { select: { title: true, wordCount: true, extractionMethod: true, createdAt: true } },
      },
    });
  },

  countPages(scope: Scope, websiteId: string) {
    return prisma.contentPage.groupBy({
      by: ['status'],
      where: { organizationId: scope.organizationId, projectId: scope.projectId, websiteId },
      _count: true,
    });
  },

  getPage(scope: Scope, websiteId: string, pageId: string) {
    return prisma.contentPage.findFirst({
      where: { id: pageId, websiteId, organizationId: scope.organizationId, projectId: scope.projectId },
      select: {
        id: true,
        url: true,
        status: true,
        httpStatus: true,
        canonicalUrl: true,
        redirectedTo: true,
        noindex: true,
        lastCrawledAt: true,
        currentVersionNo: true,
        createdAt: true,
        currentVersion: {
          select: {
            id: true,
            versionNo: true,
            title: true,
            metaDescription: true,
            canonicalUrl: true,
            language: true,
            robotsMeta: true,
            seoMeta: true,
            h1: true,
            headings: true,
            wordCount: true,
            contentHash: true,
            extractionMethod: true,
            crawlerVersion: true,
            httpStatus: true,
            invalidJsonLd: true,
            createdAt: true,
            pageSections: { orderBy: { order: 'asc' }, select: { sectionKey: true, order: true, heading: true, level: true, text: true, wordCount: true, blocks: true } },
            links: { orderBy: { id: 'asc' }, select: { targetUrl: true, anchorText: true, isInternal: true, inContent: true, rel: true, nofollow: true } },
            images: { orderBy: { id: 'asc' }, select: { src: true, alt: true, title: true, width: true, height: true, inContent: true } },
            structuredData: { orderBy: { id: 'asc' }, select: { types: true, data: true } },
          },
        },
      },
    });
  },

  async listVersions(scope: Scope, websiteId: string, pageId: string) {
    const page = await prisma.contentPage.findFirst({
      where: { id: pageId, websiteId, organizationId: scope.organizationId, projectId: scope.projectId },
      select: { id: true },
    });
    if (!page) return null;
    return prisma.contentPageVersion.findMany({
      where: { pageId, organizationId: scope.organizationId },
      orderBy: { versionNo: 'desc' },
      select: { id: true, versionNo: true, source: true, title: true, wordCount: true, contentHash: true, extractionMethod: true, crawlerVersion: true, httpStatus: true, crawlJobId: true, createdAt: true },
    });
  },
};
