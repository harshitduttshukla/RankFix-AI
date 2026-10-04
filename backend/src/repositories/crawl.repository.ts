import type { CrawlOutcome, CrawlStatus, ExtractionMethod, Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import type { TenantContext } from '../types/tenant.js';
import type { Db } from './types.js';

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;

/** Only the tenant keys; never spread a full TenantContext (role/userId) into a where clause. */
const t = (scope: Scope) => ({ organizationId: scope.organizationId, projectId: scope.projectId });

export const ACTIVE_CRAWL: CrawlStatus[] = ['PENDING', 'RUNNING'];

export type CrawlCounters = Partial<
  Record<
    | 'pagesDiscovered'
    | 'pagesProcessed'
    | 'pagesSucceeded'
    | 'pagesFailed'
    | 'pagesSkipped'
    | 'pagesCreated'
    | 'pagesUpdated'
    | 'pagesUnchanged'
    | 'renderedPages',
    number
  >
>;

const crawlSelect = {
  id: true,
  websiteId: true,
  status: true,
  discoveryMethod: true,
  sitemapUrls: true,
  robotsFound: true,
  config: true,
  pagesDiscovered: true,
  pagesProcessed: true,
  pagesSucceeded: true,
  pagesFailed: true,
  pagesSkipped: true,
  pagesCreated: true,
  pagesUpdated: true,
  pagesUnchanged: true,
  renderedPages: true,
  error: true,
  cancelRequestedAt: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const;

export const crawlRepository = {
  findActive(scope: Scope, websiteId: string, db: Db = prisma) {
    return db.crawlJob.findFirst({
      where: { ...t(scope), websiteId, status: { in: ACTIVE_CRAWL } },
      select: crawlSelect,
    });
  },

  create(scope: Scope & { userId: string }, websiteId: string, config: Prisma.InputJsonValue, db: Db = prisma) {
    return db.crawlJob.create({
      data: { organizationId: scope.organizationId, projectId: scope.projectId, websiteId, requestedById: scope.userId, config },
      select: crawlSelect,
    });
  },

  list(scope: Scope, websiteId: string, limit = 20) {
    return prisma.crawlJob.findMany({ where: { ...t(scope), websiteId }, orderBy: { createdAt: 'desc' }, take: limit, select: crawlSelect });
  },

  get(scope: Scope, websiteId: string, crawlId: string) {
    return prisma.crawlJob.findFirst({ where: { ...t(scope), websiteId, id: crawlId }, select: crawlSelect });
  },

  results(organizationId: string, crawlJobId: string, outcomes: CrawlOutcome[], limit = 200) {
    return prisma.crawlPageResult.findMany({
      where: { organizationId, crawlJobId, outcome: { in: outcomes } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { url: true, finalUrl: true, outcome: true, httpStatus: true, extractionMethod: true, errorCode: true, errorMessage: true, durationMs: true, pageId: true, createdAt: true },
    });
  },

  /** Worker-side load (by id only; the job row carries its own tenant scope). */
  loadForRun(crawlJobId: string) {
    return prisma.crawlJob.findUnique({
      where: { id: crawlJobId },
      include: { website: { select: { id: true, organizationId: true, projectId: true, baseUrl: true, hostname: true, blogPathPrefix: true } } },
    });
  },

  /** Conditional transition; returns false if the job was not in an expected state. */
  async transition(id: string, from: CrawlStatus[], data: Prisma.CrawlJobUpdateManyMutationInput) {
    const res = await prisma.crawlJob.updateMany({ where: { id, status: { in: from } }, data });
    return res.count === 1;
  },

  update(id: string, data: Prisma.CrawlJobUpdateInput) {
    return prisma.crawlJob.update({ where: { id }, data });
  },

  async cancelRequested(id: string) {
    const row = await prisma.crawlJob.findUnique({ where: { id }, select: { cancelRequestedAt: true } });
    return Boolean(row?.cancelRequestedAt);
  },

  recordResult(data: {
    organizationId: string;
    crawlJobId: string;
    url: string;
    finalUrl?: string | null;
    outcome: CrawlOutcome;
    httpStatus?: number | null;
    extractionMethod?: ExtractionMethod | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    durationMs: number;
    pageId?: string | null;
    versionId?: string | null;
  }) {
    return prisma.crawlPageResult.create({ data: { ...data, errorMessage: data.errorMessage?.slice(0, 500) ?? null } });
  },

  /** Crawls left RUNNING by a dead worker. */
  failStale(olderThan: Date) {
    return prisma.crawlJob.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: olderThan } },
      data: { status: 'FAILED', error: 'Crawl was interrupted (worker stopped)', completedAt: new Date() },
    });
  },
};
