import { prisma } from '../../config/database.js';
import { enqueueGscSync } from '../../queues/gsc.queue.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { gscRepository } from '../../repositories/gsc.repository.js';
import { projectRepository } from '../../repositories/project.repository.js';
import { websiteRepository } from '../../repositories/website.repository.js';
import type { PerformanceInput, SelectPropertyInput, SyncInput } from '../../schemas/gsc.schema.js';
import { ROLE_RANK, type TenantContext } from '../../types/tenant.js';
import { decryptSecret, encryptSecret } from '../../utils/crypto.js';
import { addDays, isoDate, latestFinalGscDate, utcDay } from '../../utils/dates.js';
import { AppError, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { normalizePageUrl, propertyCoversHost } from '../../utils/url.js';
import { GSC_SCOPE, GoogleAuthRevokedError, GscApiError, gscApi } from './gsc-api.client.js';
import { consumeOAuthState, createOAuthState } from './oauth-state.js';

export type OAuthResult = { ok: true } | { ok: false; reason: string };

async function requireConnection(tenant: TenantContext) {
  const connection = await gscRepository.getConnection(tenant);
  if (!connection) throw new AppError('GSC_NOT_CONNECTED', 'Search Console is not connected for this project');
  if (connection.revokedAt) {
    throw new AppError('GSC_NOT_CONNECTED', 'Search Console access was revoked. Reconnect to continue.');
  }
  return connection;
}

async function listSitesFor(connection: { id: string; refreshTokenEnc: string }) {
  try {
    return await gscApi().listSites(decryptSecret(connection.refreshTokenEnc));
  } catch (err) {
    if (err instanceof GoogleAuthRevokedError) {
      await gscRepository.markRevoked(connection.id);
      throw new AppError('GSC_NOT_CONNECTED', err.message);
    }
    if (err instanceof GscApiError) throw new AppError('UPDATE_PROVIDER_ERROR', `Search Console: ${err.message}`);
    throw err;
  }
}

export const gscService = {
  /** Step 1: build the Google consent URL. */
  async connect(tenant: TenantContext) {
    return { authUrl: gscApi().authUrl(await createOAuthState(tenant.projectId, tenant.userId)) };
  },

  /** Step 2: Google redirects back here. Never throws; result drives a redirect to the UI. */
  async handleCallback(
    query: { code?: string; state?: string; error?: string },
    userId: string | undefined,
    ip?: string,
  ): Promise<OAuthResult> {
    if (query.error) return { ok: false, reason: query.error === 'access_denied' ? 'access_denied' : 'google_error' };
    if (!query.code || !query.state) return { ok: false, reason: 'invalid_request' };

    const state = await consumeOAuthState(query.state);
    if (!state) return { ok: false, reason: 'invalid_state' };
    if (!userId || userId !== state.uid) return { ok: false, reason: 'session_mismatch' };

    // Re-check authorization at completion time; membership may have changed during the flow.
    const access = await projectRepository.findAccessible(state.pid, userId);
    if (!access || ROLE_RANK[access.role] < ROLE_RANK.ADMIN) return { ok: false, reason: 'forbidden' };
    const tenant: TenantContext = {
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      role: access.role,
      userId,
    };

    let tokens;
    try {
      tokens = await gscApi().exchangeCode(query.code);
    } catch (err) {
      logger.warn({ err }, 'GSC OAuth code exchange failed');
      return { ok: false, reason: 'exchange_failed' };
    }
    if (!tokens.scope.split(' ').includes(GSC_SCOPE)) return { ok: false, reason: 'scope_missing' };
    if (!tokens.refreshToken) return { ok: false, reason: 'no_refresh_token' };

    await prisma.$transaction(async (tx) => {
      const connection = await gscRepository.upsertConnection(
        tenant,
        { googleEmail: tokens.email ?? 'unknown', refreshTokenEnc: encryptSecret(tokens.refreshToken!), scope: GSC_SCOPE },
        tx,
      );
      await auditRepository.record(
        {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          actorUserId: userId,
          action: 'gsc.connected',
          entityType: 'GSCConnection',
          entityId: connection.id,
          metadata: { googleEmail: tokens.email },
          ip,
        },
        tx,
      );
    });
    return { ok: true };
  },

  async status(tenant: TenantContext) {
    const connection = await gscRepository.getConnection(tenant);
    const properties = await gscRepository.listProperties(tenant);
    return {
      connected: Boolean(connection && !connection.revokedAt),
      revoked: Boolean(connection?.revokedAt),
      googleEmail: connection?.googleEmail ?? null,
      connectedAt: connection?.updatedAt ?? null,
      properties: properties.map((p) => ({
        ...p,
        lastSyncedDate: p.lastSyncedDate ? isoDate(p.lastSyncedDate) : null,
      })),
    };
  },

  /** Properties visible to the connected Google account, flagged with which project website they could map to. */
  async getProperties(tenant: TenantContext) {
    const connection = await requireConnection(tenant);
    const [sites, websites, mapped] = await Promise.all([
      listSitesFor(connection),
      websiteRepository.listByProject(tenant),
      gscRepository.listProperties(tenant),
    ]);
    return {
      properties: sites
        .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
        .map((s) => ({
          siteUrl: s.siteUrl,
          permissionLevel: s.permissionLevel,
          matchingWebsiteIds: websites.filter((w) => propertyCoversHost(s.siteUrl, w.hostname)).map((w) => w.id),
          mappedWebsiteIds: mapped.filter((m) => m.siteUrl === s.siteUrl).map((m) => m.websiteId),
        })),
    };
  },

  async selectProperty(tenant: TenantContext, input: SelectPropertyInput) {
    const connection = await requireConnection(tenant);
    const website = await websiteRepository.findById(tenant, input.websiteId);
    if (!website) throw notFound('Website');

    // Only accept a property the connected Google account actually has verified access to.
    const site = (await listSitesFor(connection)).find((s) => s.siteUrl === input.siteUrl);
    if (!site || site.permissionLevel === 'siteUnverifiedUser') {
      throw new AppError('FORBIDDEN', 'The connected Google account does not have access to this property');
    }
    if (!propertyCoversHost(site.siteUrl, website.hostname)) {
      throw new AppError('VALIDATION_ERROR', `Property ${site.siteUrl} does not cover ${website.hostname}`);
    }

    return prisma.$transaction(async (tx) => {
      const property = await gscRepository.upsertProperty(
        tenant,
        { connectionId: connection.id, websiteId: website.id, siteUrl: site.siteUrl, permissionLevel: site.permissionLevel },
        tx,
      );
      await auditRepository.record(
        {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          actorUserId: tenant.userId,
          action: 'gsc.property_selected',
          entityType: 'GSCProperty',
          entityId: property.id,
          metadata: { siteUrl: site.siteUrl, websiteId: website.id },
        },
        tx,
      );
      return property;
    });
  },

  /** Enqueues background syncs; never blocks on Google. */
  async syncSearchAnalytics(tenant: TenantContext, input: SyncInput) {
    await requireConnection(tenant);
    const properties = (await gscRepository.listProperties(tenant)).filter(
      (p) => !input.websiteId || p.websiteId === input.websiteId,
    );
    if (!properties.length) {
      throw new AppError('VALIDATION_ERROR', 'No Search Console property is mapped to a website yet');
    }
    const jobs = [];
    for (const p of properties) {
      const jobId = await enqueueGscSync({
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        propertyId: p.id,
        days: input.days,
      });
      await gscRepository.setSyncState(p.id, { syncStatus: 'QUEUED', syncError: null });
      jobs.push({ propertyId: p.id, websiteId: p.websiteId, jobId });
    }
    await auditRepository.record({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      actorUserId: tenant.userId,
      action: 'gsc.sync_requested',
      entityType: 'Project',
      entityId: tenant.projectId,
      metadata: { propertyIds: jobs.map((j) => j.propertyId), days: input.days ?? null },
    });
    return { jobs };
  },

  /**
   * Site-level (top pages) or page-level (with queries) performance from stored data.
   * Default window: last 28 days of final GSC data.
   */
  async getPerformance(tenant: TenantContext, input: PerformanceInput) {
    const end = input.end ? utcDay(input.end) : latestFinalGscDate();
    const start = input.start ? utcDay(input.start) : addDays(end, -27);
    let propertyId: string | undefined;
    if (input.websiteId) {
      const property = (await gscRepository.listProperties(tenant)).find((p) => p.websiteId === input.websiteId);
      if (!property) throw notFound('Search Console property for website');
      propertyId = property.id;
    }
    const pageUrl = input.pageUrl ? normalizePageUrl(input.pageUrl) : undefined;
    if (input.pageUrl && !pageUrl) throw new AppError('VALIDATION_ERROR', 'Invalid pageUrl');
    const f = { start, end, propertyId, pageUrl: pageUrl ?? undefined };

    const window = { start: isoDate(start), end: isoDate(end) };
    if (pageUrl) {
      const [totals, daily, queries] = await Promise.all([
        gscRepository.totals(tenant, f),
        gscRepository.daily(tenant, f),
        gscRepository.topQueries(tenant, f),
      ]);
      return { window, pageUrl, totals, daily, queries };
    }
    const [totals, daily, pages] = await Promise.all([
      gscRepository.totals(tenant, f),
      gscRepository.daily(tenant, f),
      gscRepository.topPages(tenant, f),
    ]);
    return { window, totals, daily, pages };
  },

  /** Same window length immediately before, for trend comparisons (used by the opportunity engine). */
  async getHistoricalPerformance(tenant: TenantContext, pageUrl: string, days = 28, end = latestFinalGscDate()) {
    const curStart = addDays(end, -(days - 1));
    const prevEnd = addDays(curStart, -1);
    const prevStart = addDays(prevEnd, -(days - 1));
    const [current, previous] = await Promise.all([
      gscRepository.totals(tenant, { start: curStart, end, pageUrl }),
      gscRepository.totals(tenant, { start: prevStart, end: prevEnd, pageUrl }),
    ]);
    return {
      current: { start: isoDate(curStart), end: isoDate(end), ...current },
      previous: { start: isoDate(prevStart), end: isoDate(prevEnd), ...previous },
    };
  },

  async disconnect(tenant: TenantContext) {
    const connection = await gscRepository.getConnection(tenant);
    if (!connection) return;
    try {
      await gscApi().revoke(decryptSecret(connection.refreshTokenEnc));
    } catch (err) {
      logger.warn({ err }, 'Google token revocation failed; deleting local connection anyway');
    }
    await prisma.$transaction(async (tx) => {
      await gscRepository.deleteConnection(tenant, tx); // cascades properties + analytics
      await auditRepository.record(
        {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          actorUserId: tenant.userId,
          action: 'gsc.disconnected',
          entityType: 'GSCConnection',
          entityId: connection.id,
        },
        tx,
      );
    });
  },
};
