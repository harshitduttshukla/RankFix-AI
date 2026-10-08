import type { OpportunityStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { enqueueOpportunityDetection } from '../../queues/opportunity.queue.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { opportunityRepository, REFRESHABLE } from '../../repositories/opportunity.repository.js';
import { toIsoDate } from '../../repositories/gsc.repository.js';
import type { DismissInput, OpportunitiesInput } from '../../schemas/opportunity.schema.js';
import type { TenantContext } from '../../types/tenant.js';
import { AppError, notFound } from '../../utils/errors.js';
import { opportunityConfig } from './opportunity.config.js';

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;

const STATUS_FILTER: Record<OpportunitiesInput['status'], OpportunityStatus[] | undefined> = {
  open: [...REFRESHABLE, 'PROPOSED'], // in human review (Phase 6) counts as open
  dismissed: ['DISMISSED'],
  all: undefined,
};

function runView(run: Awaited<ReturnType<typeof opportunityRepository.latestRun>>) {
  if (!run) return null;
  const { config: _config, organizationId: _o, projectId: _p, ...rest } = run;
  return rest;
}

export const opportunityService = {
  /**
   * Creates a detection run and hands it to the worker; never evaluates pages in the HTTP request.
   * A run already waiting in the queue absorbs further requests (it will read the latest data when it starts).
   */
  async requestDetection(tenant: Scope, opts: { trigger: 'MANUAL' | 'GSC_SYNC'; userId: string | null }) {
    const scope = { organizationId: tenant.organizationId, projectId: tenant.projectId };
    const queued = await opportunityRepository.findQueuedRun(scope);
    if (queued) return runView(queued)!;
    const run = await opportunityRepository.createRun(scope, { trigger: opts.trigger, requestedById: opts.userId, config: opportunityConfig() });
    await enqueueOpportunityDetection(run.id);
    await auditRepository.record({
      ...scope,
      actorUserId: opts.userId,
      action: 'opportunity.detection_requested',
      entityType: 'OpportunityDetectionRun',
      entityId: run.id,
      metadata: { trigger: opts.trigger },
    });
    return runView(run)!;
  },

  async detect(tenant: TenantContext) {
    const properties = await prisma.gSCProperty.count({ where: { organizationId: tenant.organizationId, projectId: tenant.projectId, lastSyncedDate: { not: null } } });
    if (!properties) throw new AppError('VALIDATION_ERROR', 'Sync Search Console data for a website before detecting opportunities');
    return opportunityService.requestDetection(tenant, { trigger: 'MANUAL', userId: tenant.userId });
  },

  async list(tenant: TenantContext, input: OpportunitiesInput) {
    const [items, total] = await opportunityRepository.list(tenant, {
      statuses: STATUS_FILTER[input.status],
      type: input.type,
      websiteId: input.websiteId,
      limit: input.limit,
      offset: input.offset,
    });
    const latestRun = await opportunityRepository.latestRun(tenant);
    return {
      items: items.map(({ evidence, dateRangeStart, dateRangeEnd, ...o }) => ({
        ...o,
        dateRangeStart: toIsoDate(dateRangeStart),
        dateRangeEnd: toIsoDate(dateRangeEnd),
        // The list shows *why* next to the score: the triggering evidence only.
        reasons: (evidence as { primary: boolean; text: string }[]).filter((e) => e.primary).map((e) => e.text),
      })),
      total,
      latestRun: runView(latestRun),
    };
  },

  async get(tenant: TenantContext, id: string) {
    const o = await opportunityRepository.find(tenant, id);
    if (!o) throw notFound('Opportunity');
    const { organizationId: _o, projectId: _p, page, dateRangeStart, dateRangeEnd, ...rest } = o;
    return {
      ...rest,
      dateRangeStart: toIsoDate(dateRangeStart),
      dateRangeEnd: toIsoDate(dateRangeEnd),
      page: {
        id: page.id,
        websiteId: page.websiteId,
        url: page.url,
        status: page.status,
        lastCrawledAt: page.lastCrawledAt,
        title: page.currentVersion?.title ?? null,
        metaDescription: page.currentVersion?.metaDescription ?? null,
        h1: page.currentVersion?.h1 ?? null,
        wordCount: page.currentVersion?.wordCount ?? null,
        versionNo: page.currentVersion?.versionNo ?? null,
      },
    };
  },

  async dismiss(tenant: TenantContext, id: string, input: DismissInput) {
    const existing = await opportunityRepository.find(tenant, id);
    if (!existing) throw notFound('Opportunity');
    await prisma.$transaction(async (tx) => {
      const { count } = await opportunityRepository.dismiss(tenant, id, { userId: tenant.userId, reason: input.reason ?? null }, tx);
      if (!count) throw new AppError('INVALID_STATE_TRANSITION', `Cannot dismiss an opportunity in status ${existing.status}`);
      await auditRepository.record(
        {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          actorUserId: tenant.userId,
          action: 'opportunity.dismissed',
          entityType: 'OptimizationOpportunity',
          entityId: id,
          metadata: { reason: input.reason ?? null, type: existing.type, pageId: existing.pageId },
        },
        tx,
      );
    });
    return opportunityService.get(tenant, id);
  },
};
