import { prisma } from '../../config/database.js';
import { toIsoDate } from '../../repositories/gsc.repository.js';
import type { TenantContext } from '../../types/tenant.js';
import { notFound } from '../../utils/errors.js';
import type { Evidence, OpportunityMetrics, QueryMetrics, ScoreBreakdownItem } from '../optimization/opportunity.types.js';

export const CONTEXT_VERSION = 'opportunity-context-v1';

/** Size limits keep prompts focused and bounded; truncation is always flagged in the context itself. */
export const CONTEXT_LIMITS = {
  maxSectionChars: 4_000,
  maxContentChars: 40_000,
  maxInternalLinks: 40,
  maxQueries: 25,
};

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;

export interface AIContext {
  contextVersion: string;
  project: { name: string };
  website: { baseUrl: string; blogPathPrefix: string | null };
  opportunity: {
    id: string;
    type: string;
    score: number;
    status: string;
    dateRange: { start: string; end: string };
    scoreBreakdown: ScoreBreakdownItem[];
    metrics: Pick<OpportunityMetrics, 'current' | 'previous' | 'expectedCtr' | 'queryCount' | 'clickChangePercent' | 'ctrChangePercent' | 'positionChange'>;
    evidence: Pick<Evidence, 'type' | 'primary' | 'metric' | 'unit' | 'value' | 'threshold' | 'previousValue' | 'query' | 'text'>[];
    topQueries: QueryMetrics[];
  };
  page: {
    url: string;
    status: string;
    lastCrawledAt: string;
    content: null | {
      versionId: string;
      versionNo: number;
      title: string | null;
      metaDescription: string | null;
      canonicalUrl: string | null;
      language: string | null;
      robotsMeta: string | null;
      h1: string | null;
      headings: { level: number; text: string }[];
      wordCount: number;
      sections: { sectionKey: string; heading: string | null; level: number; wordCount: number; text: string; truncated: boolean }[];
      internalLinks: { targetUrl: string; anchorText: string }[];
      internalLinkCount: number;
      structuredDataTypes: string[];
      imagesMissingAlt: number;
      extractionMethod: string | null;
      contentTruncated: boolean;
    };
  };
}

/**
 * Builds the prompt context for one opportunity from trusted stored data only.
 * Every lookup is scoped by organizationId + projectId, and the page/website are reached through the
 * opportunity's own (websiteId, pageId), so another tenant's data cannot be pulled in.
 */
export async function buildAIContext(scope: Scope, opportunityId: string): Promise<AIContext> {
  const t = { organizationId: scope.organizationId, projectId: scope.projectId };
  const opp = await prisma.optimizationOpportunity.findFirst({ where: { id: opportunityId, ...t } });
  if (!opp) throw notFound('Opportunity');

  const [project, website, page] = await Promise.all([
    prisma.project.findFirst({ where: { id: t.projectId, organizationId: t.organizationId }, select: { name: true } }),
    prisma.website.findFirst({ where: { id: opp.websiteId, ...t }, select: { baseUrl: true, blogPathPrefix: true } }),
    prisma.contentPage.findFirst({
      where: { id: opp.pageId, websiteId: opp.websiteId, ...t },
      select: {
        url: true,
        status: true,
        lastCrawledAt: true,
        currentVersion: {
          select: {
            id: true,
            versionNo: true,
            title: true,
            metaDescription: true,
            canonicalUrl: true,
            language: true,
            robotsMeta: true,
            h1: true,
            headings: true,
            wordCount: true,
            extractionMethod: true,
            pageSections: { orderBy: { order: 'asc' }, select: { sectionKey: true, heading: true, level: true, wordCount: true, text: true } },
            links: { where: { isInternal: true, inContent: true }, select: { targetUrl: true, anchorText: true } },
            images: { where: { inContent: true }, select: { alt: true } },
            structuredData: { select: { types: true } },
          },
        },
      },
    }),
  ]);
  if (!project || !website || !page) throw notFound('Opportunity');

  const metrics = opp.metrics as unknown as OpportunityMetrics;
  const v = page.currentVersion;

  let budget = CONTEXT_LIMITS.maxContentChars;
  let contentTruncated = false;
  const sections = (v?.pageSections ?? []).map((s) => {
    const cap = Math.max(0, Math.min(CONTEXT_LIMITS.maxSectionChars, budget));
    const truncated = s.text.length > cap;
    if (truncated) contentTruncated = true;
    const text = truncated ? s.text.slice(0, cap) : s.text;
    budget -= text.length;
    return { sectionKey: s.sectionKey, heading: s.heading, level: s.level, wordCount: s.wordCount, text, truncated };
  });

  return {
    contextVersion: CONTEXT_VERSION,
    project: { name: project.name },
    website: { baseUrl: website.baseUrl, blogPathPrefix: website.blogPathPrefix },
    opportunity: {
      id: opp.id,
      type: opp.type,
      score: opp.score,
      status: opp.status,
      dateRange: { start: toIsoDate(opp.dateRangeStart), end: toIsoDate(opp.dateRangeEnd) },
      scoreBreakdown: opp.scoreBreakdown as unknown as ScoreBreakdownItem[],
      metrics: {
        current: metrics.current,
        previous: metrics.previous,
        expectedCtr: metrics.expectedCtr,
        queryCount: metrics.queryCount,
        clickChangePercent: metrics.clickChangePercent,
        ctrChangePercent: metrics.ctrChangePercent,
        positionChange: metrics.positionChange,
      },
      evidence: (opp.evidence as unknown as Evidence[]).map(({ type, primary, metric, unit, value, threshold, previousValue, query, text }) => ({
        type, primary, metric, unit, value, threshold, previousValue, query, text,
      })),
      topQueries: (opp.topQueries as unknown as QueryMetrics[]).slice(0, CONTEXT_LIMITS.maxQueries),
    },
    page: {
      url: page.url,
      status: page.status,
      lastCrawledAt: page.lastCrawledAt.toISOString(),
      content: v
        ? {
            versionId: v.id,
            versionNo: v.versionNo,
            title: v.title,
            metaDescription: v.metaDescription,
            canonicalUrl: v.canonicalUrl,
            language: v.language,
            robotsMeta: v.robotsMeta,
            h1: v.h1,
            headings: (v.headings as { level: number; text: string }[]).map(({ level, text }) => ({ level, text })),
            wordCount: v.wordCount,
            sections,
            internalLinks: v.links.slice(0, CONTEXT_LIMITS.maxInternalLinks),
            internalLinkCount: v.links.length,
            structuredDataTypes: [...new Set(v.structuredData.flatMap((d) => d.types))],
            imagesMissingAlt: v.images.filter((i) => i.alt === null).length,
            extractionMethod: v.extractionMethod,
            contentTruncated: contentTruncated || v.links.length > CONTEXT_LIMITS.maxInternalLinks,
          }
        : null,
    },
  };
}
