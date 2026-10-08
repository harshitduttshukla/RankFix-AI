import { z } from 'zod';

/*
 * Output contracts for Claude. The same schemas are sent as the structured-output format and used to
 * re-validate the response before anything is persisted. Keep them free of constraints the structured-output
 * JSON Schema subset can't express; numeric/length limits are enforced here on re-validation.
 */

export const INTENTS = ['INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'NAVIGATIONAL', 'MIXED', 'UNKNOWN'] as const;

export const OBSERVATION_TYPES = ['PERFORMANCE', 'RANKING', 'CTR', 'TREND', 'QUERY', 'CONTENT_STRUCTURE', 'METADATA', 'INTERNAL_LINKS'] as const;

export const RECOMMENDATION_TYPES = [
  'TITLE',
  'META_DESCRIPTION',
  'HEADING',
  'SECTION_EXPANSION',
  'MISSING_TOPIC',
  'CLARIFICATION',
  'INTERNAL_LINK',
  'INTRODUCTION',
] as const;

const confidence = z.number().min(0).max(1);
const text = (max: number) => z.string().trim().min(1).max(max);

/** Something directly visible in the supplied metrics or page content. */
export const Observation = z.object({
  type: z.enum(OBSERVATION_TYPES),
  statement: text(600),
  /** Concrete facts from the context backing the statement (metric values, quoted headings, query names). */
  evidence: z.array(text(400)).min(1).max(6),
});

/** A hedged reading of the observations. Never stated as fact. */
export const Interpretation = z.object({
  statement: text(600),
  basedOn: z.array(text(400)).min(1).max(6),
  confidence,
});

export const SearchIntent = z.object({
  query: text(500),
  intent: z.enum(INTENTS),
  confidence,
  reasoning: text(400),
});

export const ContentGap = z.object({
  topic: text(200),
  relatedQueries: z.array(text(500)).min(1).max(10),
  /** What the crawled page does/doesn't contain, described from the supplied content. */
  evidence: text(600),
  confidence,
});

export const OpportunityAnalysis = z.object({
  summary: text(1200),
  /** False when the supplied data is too thin to support conclusions; `insufficientEvidenceNotes` then says why. */
  evidenceSufficient: z.boolean(),
  insufficientEvidenceNotes: z.array(text(400)).max(6),
  observations: z.array(Observation).min(1).max(12),
  interpretations: z.array(Interpretation).max(8),
  searchIntent: z.array(SearchIntent).max(15),
  contentGaps: z.array(ContentGap).max(10),
  areasForInvestigation: z.array(text(400)).max(8),
});

export const Recommendation = z.object({
  type: z.enum(RECOMMENDATION_TYPES),
  /** What a human should consider changing. Edits existing content; never a new article, deletion or publish. */
  recommendation: text(800),
  rationale: text(800),
  evidence: z.array(text(400)).min(1).max(6),
  /** Section key from the context when the recommendation targets a specific section; otherwise null. */
  targetSection: z.string().max(200).nullable(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

export const RecommendationSet = z.object({
  recommendations: z.array(Recommendation).max(10),
  /** Caveats a reviewer should keep in mind (data limits, ambiguity). */
  caveats: z.array(text(400)).max(6),
});

export type OpportunityAnalysis = z.infer<typeof OpportunityAnalysis>;
export type Recommendation = z.infer<typeof Recommendation>;
export type RecommendationSet = z.infer<typeof RecommendationSet>;
export type SearchIntent = z.infer<typeof SearchIntent>;
export type ContentGap = z.infer<typeof ContentGap>;
