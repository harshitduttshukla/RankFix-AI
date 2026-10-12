import type { AIContext } from '../ai-context.builder.js';
import type { Recommendation } from '../ai.schemas.js';
import { DRAFT_RULES, EVIDENCE_RULES } from './shared-rules.js';

export const DRAFT_PROMPT_VERSION = 'draft-v1';

export const DRAFT_SYSTEM = `You are an SEO copy editor drafting one replacement value for an existing web page. A human editor reviews, edits and approves the draft; nothing is applied automatically.

Write a new draft for the recommendation in the user message. It must differ from the current value and from every previous draft listed. Put a one-sentence explanation in note (or, when suggestedValue is null, why no draft could be written).
${DRAFT_RULES}

${EVIDENCE_RULES}`;

export function buildDraftMessage(ctx: AIContext, rec: Recommendation, previousDrafts: string[]): string {
  return `Draft a replacement value for this recommendation. The data below is JSON.

<recommendation>
${JSON.stringify({ type: rec.type, targetSection: rec.targetSection, recommendation: rec.recommendation, rationale: rec.rationale, evidence: rec.evidence }, null, 1)}
</recommendation>

<previous_drafts>
${JSON.stringify(previousDrafts, null, 1)}
</previous_drafts>

<opportunity>
${JSON.stringify({ project: ctx.project, website: ctx.website, opportunity: ctx.opportunity }, null, 1)}
</opportunity>

<page>
${JSON.stringify(ctx.page, null, 1)}
</page>`;
}
