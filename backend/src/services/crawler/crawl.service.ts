import type { PageStatus, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { enqueueCrawl, removeQueuedCrawl } from '../../queues/crawl.queue.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { contentRepository } from '../../repositories/content.repository.js';
import { crawlRepository } from '../../repositories/crawl.repository.js';
import type { TenantContext } from '../../types/tenant.js';
import { AppError, notFound } from '../../utils/errors.js';
import { crawlerConfig } from './config.js';

export const crawlService = {
  async start(tenant: TenantContext, websiteId: string) {
    const config = crawlerConfig();
    const snapshot = {
      maxPages: config.maxPages,
      concurrency: config.concurrency,
      delayMs: config.delayMs,
      requestTimeoutMs: config.requestTimeoutMs,
      maxDurationMs: config.maxDurationMs,
      playwrightEnabled: config.playwrightEnabled,
      playwrightMaxPages: config.playwrightMaxPages,
      userAgent: config.userAgent,
    } satisfies Prisma.InputJsonObject;

    // Serializable so two simultaneous requests can't both pass the "no active crawl" check.
    const job = await prisma.$transaction(
      async (tx) => {
        const active = await crawlRepository.findActive(tenant, websiteId, tx);
        if (active) throw new AppError('CONFLICT', 'A crawl is already running for this website', { crawlId: active.id });
        const created = await crawlRepository.create(tenant, websiteId, snapshot, tx);
        await auditRepository.record(
          { organizationId: tenant.organizationId, projectId: tenant.projectId, actorUserId: tenant.userId, action: 'crawl.requested', entityType: 'CrawlJob', entityId: created.id },
          tx,
        );
        return created;
      },
      { isolationLevel: 'Serializable' },
    );
    await enqueueCrawl(job.id);
    return job;
  },

  list(tenant: TenantContext, websiteId: string) {
    return crawlRepository.list(tenant, websiteId);
  },

  async get(tenant: TenantContext, websiteId: string, crawlId: string) {
    const job = await crawlRepository.get(tenant, websiteId, crawlId);
    if (!job) throw notFound('Crawl');
    const [failures, skipped] = await Promise.all([
      crawlRepository.results(tenant.organizationId, crawlId, ['FAILED']),
      crawlRepository.results(tenant.organizationId, crawlId, ['SKIPPED']),
    ]);
    return { ...job, failures, skipped };
  },

  async cancel(tenant: TenantContext, websiteId: string, crawlId: string) {
    const job = await crawlRepository.get(tenant, websiteId, crawlId);
    if (!job) throw notFound('Crawl');
    if (job.status === 'PENDING') {
      await removeQueuedCrawl(crawlId);
      await crawlRepository.transition(crawlId, ['PENDING'], { status: 'CANCELLED', cancelRequestedAt: new Date(), completedAt: new Date() });
    } else if (job.status === 'RUNNING') {
      await crawlRepository.transition(crawlId, ['RUNNING'], { cancelRequestedAt: new Date() });
    } else {
      throw new AppError('INVALID_STATE_TRANSITION', `Crawl is already ${job.status.toLowerCase()}`);
    }
    await auditRepository.record({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      actorUserId: tenant.userId,
      action: 'crawl.cancel_requested',
      entityType: 'CrawlJob',
      entityId: crawlId,
    });
    return crawlRepository.get(tenant, websiteId, crawlId);
  },

  async listPages(tenant: TenantContext, websiteId: string, q: { status?: PageStatus; q?: string; cursor?: string; limit?: number }) {
    const limit = q.limit ?? 50;
    const [rows, counts] = await Promise.all([contentRepository.listPages(tenant, websiteId, { ...q, limit }), contentRepository.countPages(tenant, websiteId)]);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(({ currentVersion, ...p }) => ({
      ...p,
      title: currentVersion?.title ?? null,
      wordCount: currentVersion?.wordCount ?? null,
      extractionMethod: currentVersion?.extractionMethod ?? null,
    }));
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    };
  },

  async getPage(tenant: TenantContext, websiteId: string, pageId: string) {
    const page = await contentRepository.getPage(tenant, websiteId, pageId);
    if (!page) throw notFound('Page');
    return page;
  },

  async listVersions(tenant: TenantContext, websiteId: string, pageId: string) {
    const versions = await contentRepository.listVersions(tenant, websiteId, pageId);
    if (!versions) throw notFound('Page');
    return { items: versions };
  },
};
