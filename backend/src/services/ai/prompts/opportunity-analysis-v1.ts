import type { AIContext } from '../ai-context.builder.js';
import { EVIDENCE_RULES } from './shared-rules.js';

export const OPPORTUNITY_ANALYSIS_PROMPT_VERSION = 'opportunity-analysis-v1';

export const OPPORTUNITY_ANALYSIS_SYSTEM = `You are an SEO analyst reviewing one existing web page that a deterministic rules engine flagged as an optimization opportunity. Your analysis is read by a human editor who decides what, if anything, to change. You do not write or change content.

Your job, for this one page:
1. Describe what is measurably happening, using the supplied metrics, evidence and score breakdown.
2. Describe what the page currently covers, from its title, meta description, headings and section text.
3. Classify the search intent of the important queries (INFORMATIONAL, COMMERCIAL, TRANSACTIONAL, NAVIGATIONAL, MIXED, or UNKNOWN when the query alone doesn't tell you), with a confidence between 0 and 1. Use lower confidence for short or ambiguous queries.
4. Compare the query themes with the page and list observable content gaps: topics that appear relevant to the queries but are not clearly represented in the title, headings or section text. For each gap, describe what the page does or doesn't contain.
5. List areas a human should investigate further.

${EVIDENCE_RULES}

Set evidenceSufficient to false, and explain in insufficientEvidenceNotes, when the page content is missing or the metrics are too sparse to support the analysis. Leave lists empty rather than padding them.`;

export function buildOpportunityAnalysisMessage(ctx: AIContext): string {
  return `Analyze this opportunity. The data below is JSON.

<opportunity>
${JSON.stringify({ project: ctx.project, website: ctx.website, opportunity: ctx.opportunity }, null, 1)}
</opportunity>

<page>
${JSON.stringify(ctx.page, null, 1)}
</page>`;
}
