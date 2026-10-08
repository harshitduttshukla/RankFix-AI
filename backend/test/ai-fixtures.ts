import type { AIContext } from '../src/services/ai/ai-context.builder.js';
import { AIError } from '../src/services/ai/ai.errors.js';
import type { AIProvider, AIResult } from '../src/services/ai/ai.provider.js';
import type { OpportunityAnalysis, RecommendationSet } from '../src/services/ai/ai.schemas.js';

/** A grounded analysis for a page whose top query is "react guide". */
export function validAnalysis(over: Partial<OpportunityAnalysis> = {}): OpportunityAnalysis {
  return {
    summary: 'The page receives substantial impressions at an average position near 7 with a CTR below the typical range for that position.',
    evidenceSufficient: true,
    insufficientEvidenceNotes: [],
    observations: [
      { type: 'CTR', statement: 'CTR was 1.0% at an average position of 7.2.', evidence: ['ctr 1.0%', 'position 7.2'] },
      { type: 'CONTENT_STRUCTURE', statement: 'The headings cover hooks and state management.', evidence: ['H2 "React hooks tutorial"'] },
    ],
    interpretations: [
      { statement: 'The title may not reflect the breadth of the guide, which could be one factor in the CTR.', basedOn: ['title "React Guide"'], confidence: 0.4 },
    ],
    searchIntent: [{ query: 'react guide', intent: 'INFORMATIONAL', confidence: 0.8, reasoning: 'A general learning query.' }],
    contentGaps: [
      { topic: 'Performance profiling', relatedQueries: ['react performance'], evidence: 'No heading or section mentions profiling or performance.', confidence: 0.6 },
    ],
    areasForInvestigation: ['Whether the title matches how searchers phrase the query.'],
    ...over,
  };
}

export function validRecommendations(over: Partial<RecommendationSet> = {}): RecommendationSet {
  return {
    recommendations: [
      {
        type: 'TITLE',
        recommendation: 'Consider a title that names the topics the guide covers, such as hooks and state management.',
        rationale: 'The page ranks on page one but its CTR is below the typical range for its position.',
        evidence: ['ctr 1.0% vs ≈3.8% typical at position 7.2'],
        targetSection: null,
        priority: 'HIGH',
      },
      {
        type: 'SECTION_EXPANSION',
        recommendation: 'Consider expanding the hooks section with examples of common hooks.',
        rationale: 'The query "react hooks tutorial" has significant impressions.',
        evidence: ['react hooks tutorial: 8,000 impressions'],
        targetSection: 's1-react-hooks-tutorial',
        priority: 'MEDIUM',
      },
    ],
    caveats: ['Search Console data shows correlation only.'],
    ...over,
  };
}

type Step<T> = T | AIError | Error | ((ctx: AIContext) => T);

/** Scriptable stand-in for Claude. Each call consumes the next scripted step (the last one repeats). */
export class FakeAI implements AIProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  analyses: Step<OpportunityAnalysis>[] = [() => validAnalysis()];
  recs: Step<RecommendationSet>[] = [() => validRecommendations()];
  contexts: AIContext[] = [];
  calls = { analyze: 0, recommend: 0 };

  async analyzeOpportunity(ctx: AIContext): Promise<AIResult<OpportunityAnalysis>> {
    this.contexts.push(ctx);
    return this.resolve(this.analyses, this.calls.analyze++, ctx, 'opportunity-analysis-v1');
  }
  async generateRecommendation(ctx: AIContext): Promise<AIResult<RecommendationSet>> {
    return this.resolve(this.recs, this.calls.recommend++, ctx, 'recommendation-v1');
  }
  private resolve<T>(steps: Step<T>[], i: number, ctx: AIContext, promptVersion: string): AIResult<T> {
    const step = steps[Math.min(i, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    const output = typeof step === 'function' ? (step as (c: AIContext) => T)(ctx) : step;
    return { output, usage: { inputTokens: 1000, outputTokens: 200 }, model: this.model, promptVersion, latencyMs: 5 };
  }
}
