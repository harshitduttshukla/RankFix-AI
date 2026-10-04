import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { gscRepository, type AnalyticsRowInput } from '../../repositories/gsc.repository.js';
import { decryptSecret } from '../../utils/crypto.js';
import { addDays, isoDate, latestFinalGscDate, utcDay } from '../../utils/dates.js';
import { normalizePageUrl } from '../../utils/url.js';
import { GoogleAuthRevokedError, gscApi, type SearchAnalyticsRow } from './gsc-api.client.js';

export interface GscSyncJobData {
  organizationId: string;
  projectId: string;
  propertyId: string;
  /** Explicit backfill length; otherwise incremental from lastSyncedDate (or initial window). */
  days?: number;
}

const ROW_LIMIT = 25_000;
const OVERLAP_DAYS = 3; // re-fetch recent days in case GSC revised them

export class SyncAbortedError extends Error {}

/**
 * Fetches GSC data day by day and stores it. Resumable: lastSyncedDate advances after each stored day.
 * Contains no AI or content logic.
 */
export async function runGscSync(data: GscSyncJobData, onProgress?: (pct: number) => Promise<void> | void) {
  const scope = { organizationId: data.organizationId, projectId: data.projectId };
  const property = await gscRepository.findProperty(scope, data.propertyId);
  if (!property) throw new SyncAbortedError('Property no longer exists');
  if (property.connection.revokedAt) throw new SyncAbortedError('Search Console access was revoked. Reconnect to sync.');

  const end = latestFinalGscDate();
  const start = data.days
    ? addDays(end, -(data.days - 1))
    : property.lastSyncedDate
      ? addDays(utcDay(property.lastSyncedDate), -OVERLAP_DAYS)
      : addDays(end, -(env.GSC_INITIAL_SYNC_DAYS - 1));

  await gscRepository.setSyncState(property.id, { syncStatus: 'RUNNING', syncError: null });

  const refreshToken = decryptSecret(property.connection.refreshTokenEnc);
  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  let done = 0;
  let rowsStored = 0;

  try {
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const date = isoDate(day);
      const [pageRows, queryRows] = await Promise.all([
        fetchAll(refreshToken, property.siteUrl, date, ['page']),
        fetchAll(refreshToken, property.siteUrl, date, ['page', 'query']),
      ]);
      const rows = [...aggregate(pageRows, false), ...aggregate(queryRows, true)];
      await gscRepository.replaceDay(property, day, rows);
      rowsStored += rows.length;
      await gscRepository.setSyncState(property.id, { syncStatus: 'RUNNING', lastSyncedDate: day });
      await onProgress?.(Math.round((++done / totalDays) * 100));
    }
  } catch (err) {
    if (err instanceof GoogleAuthRevokedError) {
      await gscRepository.markRevoked(property.connectionId);
      throw new SyncAbortedError(err.message);
    }
    throw err;
  }

  await prisma.$transaction(async (tx) => {
    await gscRepository.setSyncState(property.id, { syncStatus: 'IDLE', syncError: null, lastSyncedAt: new Date() }, tx);
    await auditRepository.record(
      {
        ...scope,
        action: 'gsc.sync_completed',
        entityType: 'GSCProperty',
        entityId: property.id,
        metadata: { start: isoDate(start), end: isoDate(end), rowsStored },
      },
      tx,
    );
  });
  return { start: isoDate(start), end: isoDate(end), rowsStored };
}

/** Called once a job has failed for good (or aborted). */
export async function markGscSyncFailed(data: GscSyncJobData, message: string) {
  const scope = { organizationId: data.organizationId, projectId: data.projectId };
  const property = await gscRepository.findProperty(scope, data.propertyId);
  if (!property) return;
  await gscRepository.setSyncState(property.id, { syncStatus: 'FAILED', syncError: message.slice(0, 500) });
  await auditRepository.record({
    ...scope,
    action: 'gsc.sync_failed',
    entityType: 'GSCProperty',
    entityId: property.id,
    metadata: { error: message.slice(0, 500) },
  });
}

async function fetchAll(refreshToken: string, siteUrl: string, date: string, dimensions: ('page' | 'query')[]) {
  const all: SearchAnalyticsRow[] = [];
  for (let startRow = 0; ; startRow += ROW_LIMIT) {
    const rows = await gscApi().querySearchAnalytics(refreshToken, siteUrl, {
      startDate: date,
      endDate: date,
      dimensions,
      rowLimit: ROW_LIMIT,
      startRow,
    });
    all.push(...rows);
    if (rows.length < ROW_LIMIT) return all;
  }
}

/**
 * Normalizes page URLs and merges rows that collapse to the same key
 * (e.g. trailing-slash or tracking-param variants). Position is impression-weighted.
 */
export function aggregate(rows: SearchAnalyticsRow[], withQuery: boolean): AnalyticsRowInput[] {
  const acc = new Map<string, { page: string; query: string; clicks: number; impressions: number; posSum: number }>();
  for (const r of rows) {
    const page = normalizePageUrl(r.keys[0] ?? '');
    if (!page) continue;
    const query = withQuery ? (r.keys[1] ?? '').slice(0, 1000) : '';
    if (withQuery && !query) continue;
    const key = `${page}\u0000${query}`;
    const cur = acc.get(key) ?? { page, query, clicks: 0, impressions: 0, posSum: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posSum += r.position * Math.max(r.impressions, 1);
    acc.set(key, cur);
  }
  return [...acc.values()].map((r) => ({
    page: r.page,
    query: r.query,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    position: r.posSum / Math.max(r.impressions, 1),
  }));
}
