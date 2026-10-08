import type { AIContext } from '../ai-context.builder.js';
import type { OpportunityAnalysis } from '../ai.schemas.js';
import { EVIDENCE_RULES } from './shared-rules.js';

export const RECOMMENDATION_PROMPT_VERSION = 'recommendation-v1';

export const RECOMMENDATION_SYSTEM = `You are an SEO analyst preparing change suggestions for a human editor to review. The editor approves or rejects each one; nothing is applied automatically.

Using the page data and the analysis already produced for it, suggest focused edits to the existing page. Allowed types:
- TITLE, META_DESCRIPTION, HEADING: improvements to existing metadata or headings
- SECTION_EXPANSION, CLARIFICATION, INTRODUCTION: deepen or clarify an existing section (give its sectionKey in targetSection)
- MISSING_TOPIC: cover a topic the analysis identified as a gap, within the existing page
- INTERNAL_LINK: link to another page of the same site, only if that page appears in the supplied internal links

Boundaries: do not propose a new article, do not propose deleting content, and do not propose publishing. Each recommendation must name the evidence it relies on (metrics, queries or page facts from the data). Rank by priority based on the strength of that evidence. Return fewer, well-supported recommendations rather than many speculative ones, and none when the evidence doesn't support any.

${EVIDENCE_RULES}`;

export function buildRecommendationMessage(ctx: AIContext, analysis: OpportunityAnalysis): string {
  return `Suggest changes for this page. The data below is JSON.

<opportunity>
${JSON.stringify({ project: ctx.project, website: ctx.website, opportunity: ctx.opportunity }, null, 1)}
</opportunity>

<page>
${JSON.stringify(ctx.page, null, 1)}
</page>

<analysis>
${JSON.stringify(analysis, null, 1)}
</analysis>`;
}
