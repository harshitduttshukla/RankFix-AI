import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { gscRepository } from '../../repositories/gsc.repository.js';
import { addDays, isoDate, latestFinalGscDate, utcDay } from '../../utils/dates.js';

type Scope = { organizationId: string; projectId: string };

export type BaselineLimitation = 'NO_GSC_PROPERTY' | 'GSC_NOT_SYNCED' | 'NO_GSC_DATA';

export interface Baseline {
  propertyId: string;
  pageUrl: string;
  windowStart: Date;
  windowEnd: Date;
  clicks: number;
  impressions: number;
  ctr: number;
  /** null when the page had no impressions in the window (there is no position, not a position of 0). */
  position: number | null;
  daysWithData: number;
  /** True only when stored data covers the whole window. A page absent from complete data had genuinely no impressions. */
  dataComplete: boolean;
  queries: { query: string; clicks: number; impressions: number; ctr: number; position: number | null }[];
}

/**
 * Pre-change Search Console baseline from data already stored for the website's mapped property (no Google calls).
 * The window is OPPORTUNITY_WINDOW_DAYS long and ends at the latest final day that is both synced and before the
 * apply request. Returns a limitation instead of inventing numbers when no usable data exists.
 */
export async function computeBaseline(
  scope: Scope,
  websiteId: string,
  pageUrl: string,
  now = new Date(),
  windowDays = env.OPPORTUNITY_WINDOW_DAYS,
): Promise<{ baseline: Baseline; limitation: null } | { baseline: null; limitation: BaselineLimitation }> {
  const property = await prisma.gSCProperty.findFirst({ where: { ...scope, websiteId }, select: { id: true, lastSyncedDate: true } });
  if (!property) return { baseline: null, limitation: 'NO_GSC_PROPERTY' };
  if (!property.lastSyncedDate) return { baseline: null, limitation: 'GSC_NOT_SYNCED' };

  const candidates = [utcDay(property.lastSyncedDate), latestFinalGscDate(now), addDays(utcDay(now), -1)];
  const windowEnd = new Date(Math.min(...candidates.map((d) => d.getTime())));
  const windowStart = addDays(windowEnd, -(windowDays - 1));

  const span = await prisma.gSCSearchAnalytics.aggregate({ where: { ...scope, propertyId: property.id, query: '' }, _min: { date: true }, _max: { date: true } });
  if (!span._min.date) return { baseline: null, limitation: 'NO_GSC_DATA' };

  const f = { start: windowStart, end: windowEnd, pageUrl, propertyId: property.id };
  const [totals, days, queries] = await Promise.all([
    gscRepository.totals(scope, f),
    prisma.gSCSearchAnalytics.count({ where: { ...scope, propertyId: property.id, page: pageUrl, query: '', date: { gte: windowStart, lte: windowEnd } } }),
    gscRepository.topQueries(scope, f, 20),
  ]);
  return {
    limitation: null,
    baseline: {
      propertyId: property.id,
      pageUrl,
      windowStart,
      windowEnd,
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: totals.ctr,
      position: totals.impressions > 0 ? totals.position : null,
      daysWithData: days,
      dataComplete: utcDay(span._min.date) <= windowStart,
      queries,
    },
  };
}

/** Insert data for the BASELINE row; (runId, kind) is unique, so writing it twice is a no-op with skipDuplicates. */
export function baselineRow(organizationId: string, runId: string, b: Baseline): Prisma.OptimizationMeasurementCreateManyInput {
  return {
    organizationId,
    runId,
    kind: 'BASELINE',
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    clicks: b.clicks,
    impressions: b.impressions,
    ctr: b.ctr,
    position: b.position,
    propertyId: b.propertyId,
    pageUrl: b.pageUrl,
    daysWithData: b.daysWithData,
    dataComplete: b.dataComplete,
    queries: b.queries as unknown as Prisma.InputJsonValue,
  };
}

export const baselineSummary = (b: Baseline | null, limitation: BaselineLimitation | null) =>
  b ? { window: { start: isoDate(b.windowStart), end: isoDate(b.windowEnd) }, dataComplete: b.dataComplete, daysWithData: b.daysWithData } : { limitation };
