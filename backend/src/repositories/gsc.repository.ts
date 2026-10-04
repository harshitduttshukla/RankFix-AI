import { Prisma, type SyncStatus } from '@prisma/client';
import { prisma } from '../config/database.js';
import type { TenantContext } from '../types/tenant.js';
import type { Db } from './types.js';

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;

export interface AnalyticsRowInput {
  page: string;
  query: string; // '' = page-level total
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface MetricTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

const propertySelect = {
  id: true,
  websiteId: true,
  siteUrl: true,
  permissionLevel: true,
  syncStatus: true,
  syncError: true,
  lastSyncedAt: true,
  lastSyncedDate: true,
  createdAt: true,
  website: { select: { baseUrl: true, hostname: true } },
} as const;

export const gscRepository = {
  getConnection(scope: Scope, db: Db = prisma) {
    return db.gSCConnection.findFirst({ where: { organizationId: scope.organizationId, projectId: scope.projectId } });
  },

  upsertConnection(
    tenant: TenantContext,
    data: { googleEmail: string; refreshTokenEnc: string; scope: string },
    db: Db = prisma,
  ) {
    const fields = { ...data, connectedById: tenant.userId, revokedAt: null };
    return db.gSCConnection.upsert({
      where: { projectId: tenant.projectId },
      create: { ...fields, organizationId: tenant.organizationId, projectId: tenant.projectId },
      update: fields,
    });
  },

  markRevoked(connectionId: string, db: Db = prisma) {
    return db.gSCConnection.update({ where: { id: connectionId }, data: { revokedAt: new Date() } });
  },

  deleteConnection(scope: Scope, db: Db = prisma) {
    return db.gSCConnection.deleteMany({ where: { organizationId: scope.organizationId, projectId: scope.projectId } });
  },

  listProperties(scope: Scope, db: Db = prisma) {
    return db.gSCProperty.findMany({
      where: { organizationId: scope.organizationId, projectId: scope.projectId },
      orderBy: { createdAt: 'asc' },
      select: propertySelect,
    });
  },

  findProperty(scope: Scope, propertyId: string, db: Db = prisma) {
    return db.gSCProperty.findFirst({
      where: { id: propertyId, organizationId: scope.organizationId, projectId: scope.projectId },
      include: { connection: true },
    });
  },

  upsertProperty(
    tenant: TenantContext,
    data: { connectionId: string; websiteId: string; siteUrl: string; permissionLevel: string },
    db: Db = prisma,
  ) {
    return db.gSCProperty.upsert({
      where: { websiteId: data.websiteId },
      create: { ...data, organizationId: tenant.organizationId, projectId: tenant.projectId },
      // Switching property for a website invalidates previously synced data.
      update: { ...data, lastSyncedDate: null, lastSyncedAt: null, syncStatus: 'IDLE', syncError: null },
      select: propertySelect,
    });
  },

  setSyncState(
    propertyId: string,
    data: { syncStatus: SyncStatus; syncError?: string | null; lastSyncedAt?: Date; lastSyncedDate?: Date },
    db: Db = prisma,
  ) {
    return db.gSCProperty.update({ where: { id: propertyId }, data });
  },

  /** Idempotent per-day write: replaces everything stored for (property, date). */
  async replaceDay(
    property: { id: string; organizationId: string; projectId: string },
    date: Date,
    rows: AnalyticsRowInput[],
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.gSCSearchAnalytics.deleteMany({ where: { propertyId: property.id, date } });
      for (let i = 0; i < rows.length; i += 5000) {
        await tx.gSCSearchAnalytics.createMany({
          data: rows.slice(i, i + 5000).map((r) => ({
            ...r,
            organizationId: property.organizationId,
            projectId: property.projectId,
            propertyId: property.id,
            date,
          })),
        });
      }
    });
  },

  /** Page-level totals (query = '') over a window, optionally for one page. Position is impression-weighted. */
  async totals(scope: Scope, f: { start: Date; end: Date; pageUrl?: string; propertyId?: string }): Promise<MetricTotals> {
    const [row] = await prisma.$queryRaw<{ clicks: bigint | null; impressions: bigint | null; wpos: number | null }[]>`
      SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions,
             SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS wpos
      FROM "GSCSearchAnalytics"
      WHERE ${scopeWhere(scope, f)} AND query = ''`;
    return toTotals(row?.clicks, row?.impressions, row?.wpos);
  },

  async daily(scope: Scope, f: { start: Date; end: Date; pageUrl?: string; propertyId?: string }) {
    const rows = await prisma.$queryRaw<{ date: Date; clicks: bigint; impressions: bigint; wpos: number | null }[]>`
      SELECT date, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
             SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS wpos
      FROM "GSCSearchAnalytics"
      WHERE ${scopeWhere(scope, f)} AND query = ''
      GROUP BY date ORDER BY date`;
    return rows.map((r) => ({ date: toIsoDate(r.date), ...toTotals(r.clicks, r.impressions, r.wpos) }));
  },

  async topQueries(scope: Scope, f: { start: Date; end: Date; pageUrl?: string; propertyId?: string }, limit = 50) {
    const rows = await prisma.$queryRaw<{ query: string; clicks: bigint; impressions: bigint; wpos: number | null }[]>`
      SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
             SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS wpos
      FROM "GSCSearchAnalytics"
      WHERE ${scopeWhere(scope, f)} AND query <> ''
      GROUP BY query ORDER BY SUM(impressions) DESC, query LIMIT ${limit}`;
    return rows.map((r) => ({ query: r.query, ...toTotals(r.clicks, r.impressions, r.wpos) }));
  },

  async topPages(scope: Scope, f: { start: Date; end: Date; propertyId?: string }, limit = 50) {
    const rows = await prisma.$queryRaw<{ page: string; clicks: bigint; impressions: bigint; wpos: number | null }[]>`
      SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
             SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS wpos
      FROM "GSCSearchAnalytics"
      WHERE ${scopeWhere(scope, f)} AND query = ''
      GROUP BY page ORDER BY SUM(impressions) DESC, page LIMIT ${limit}`;
    return rows.map((r) => ({ page: r.page, ...toTotals(r.clicks, r.impressions, r.wpos) }));
  },

  countRows(propertyId: string) {
    return prisma.gSCSearchAnalytics.count({ where: { propertyId } });
  },
};

function scopeWhere(scope: Scope, f: { start: Date; end: Date; pageUrl?: string; propertyId?: string }) {
  const parts = [
    Prisma.sql`"organizationId" = ${scope.organizationId}`,
    Prisma.sql`"projectId" = ${scope.projectId}`,
    Prisma.sql`date BETWEEN ${f.start}::date AND ${f.end}::date`,
  ];
  if (f.pageUrl) parts.push(Prisma.sql`page = ${f.pageUrl}`);
  if (f.propertyId) parts.push(Prisma.sql`"propertyId" = ${f.propertyId}`);
  return Prisma.join(parts, ' AND ');
}

function toTotals(clicks: bigint | null | undefined, impressions: bigint | null | undefined, wpos: number | null | undefined): MetricTotals {
  const c = Number(clicks ?? 0);
  const i = Number(impressions ?? 0);
  return {
    clicks: c,
    impressions: i,
    ctr: i > 0 ? c / i : 0,
    position: wpos == null ? null : Math.round(Number(wpos) * 100) / 100,
  };
}

export const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);
