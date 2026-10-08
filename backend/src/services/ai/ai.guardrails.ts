import type { AIContext } from './ai-context.builder.js';
import type { OpportunityAnalysis, RecommendationSet } from './ai.schemas.js';

/*
 * Checks a schema-valid response against the context it was produced from. A violation means the output
 * is not grounded in the supplied data (or makes forbidden claims) and must not be stored as a success.
 */

/** Promissory or certain causal wording the product must never show. */
const FORBIDDEN = [
  /\bwill (?:increase|improve|boost|raise|grow|lift|double|fix)\b/i,
  /\bguarantee[sd]?\b/i,
  /\bdefinitely\b/i,
  /\bcertainly (?:will|is|caused)\b/i,
  /\bthis is (?:the|why) (?:reason|cause)\b/i,
];

const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ');

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

function forbiddenLanguage(value: unknown): string[] {
  return strings(value).flatMap((s) => FORBIDDEN.filter((re) => re.test(s)).map((re) => `forbidden wording ${re} in "${s.slice(0, 80)}"`));
}

export function checkAnalysis(ctx: AIContext, a: OpportunityAnalysis): string[] {
  const issues: string[] = [];
  const queries = new Set(ctx.opportunity.topQueries.map((q) => norm(q.query)));
  for (const si of a.searchIntent) {
    if (!queries.has(norm(si.query))) issues.push(`searchIntent references a query not in the data: "${si.query}"`);
  }
  for (const gap of a.contentGaps) {
    for (const q of gap.relatedQueries) if (!queries.has(norm(q))) issues.push(`contentGap "${gap.topic}" references an unknown query: "${q}"`);
  }
  if (!ctx.page.content && a.evidenceSufficient) issues.push('evidenceSufficient is true but no crawled page content was supplied');
  if (!ctx.page.content && a.contentGaps.length) issues.push('content gaps reported without any crawled page content');
  issues.push(...forbiddenLanguage(a));
  return issues;
}

export function checkRecommendations(ctx: AIContext, r: RecommendationSet): string[] {
  const issues: string[] = [];
  const sections = new Set(ctx.page.content?.sections.map((s) => s.sectionKey) ?? []);
  for (const rec of r.recommendations) {
    if (rec.targetSection && !sections.has(rec.targetSection)) issues.push(`recommendation targets an unknown section: "${rec.targetSection}"`);
  }
  issues.push(...forbiddenLanguage(r));
  return issues;
}
