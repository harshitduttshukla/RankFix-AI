import type { AIContext } from '../src/services/ai/ai-context.builder.js';
import { AIError } from '../src/services/ai/ai.errors.js';
import type { AIProvider, AIResult } from '../src/services/ai/ai.provider.js';
import type { DraftOutput, OpportunityAnalysis, Recommendation, RecommendationSet } from '../src/services/ai/ai.schemas.js';

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
        suggestedValue: 'React Guide: React Hooks Tutorial',
      },
      {
        type: 'SECTION_EXPANSION',
        recommendation: 'Consider expanding the hooks section with examples of common hooks.',
        rationale: 'The query "react hooks tutorial" has significant impressions.',
        evidence: ['react hooks tutorial: 8,000 impressions'],
        targetSection: 's1-react-hooks-tutorial',
        priority: 'MEDIUM',
        suggestedValue: null,
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
  drafts: Step<DraftOutput>[] = [{ suggestedValue: 'React Guide covering the React hooks tutorial', note: 'Names the hooks section.' }];
  contexts: AIContext[] = [];
  draftRequests: { rec: Recommendation; previous: string[] }[] = [];
  calls = { analyze: 0, recommend: 0, draft: 0 };

  async analyzeOpportunity(ctx: AIContext): Promise<AIResult<OpportunityAnalysis>> {
    this.contexts.push(ctx);
    return this.resolve(this.analyses, this.calls.analyze++, ctx, 'opportunity-analysis-v1');
  }
  async generateRecommendation(ctx: AIContext): Promise<AIResult<RecommendationSet>> {
    return this.resolve(this.recs, this.calls.recommend++, ctx, 'recommendation-v2');
  }
  async generateDraft(ctx: AIContext, rec: Recommendation, previous: string[]): Promise<AIResult<DraftOutput>> {
    this.draftRequests.push({ rec, previous });
    return this.resolve(this.drafts, this.calls.draft++, ctx, 'draft-v1');
  }
  private resolve<T>(steps: Step<T>[], i: number, ctx: AIContext, promptVersion: string): AIResult<T> {
    const step = steps[Math.min(i, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    const output = typeof step === 'function' ? (step as (c: AIContext) => T)(ctx) : step;
    return { output, usage: { inputTokens: 1000, outputTokens: 200 }, model: this.model, promptVersion, latencyMs: 5 };
  }
}

/** A complete AI context for a page whose top query is "react guide" (unit tests; no database). */
export function sampleContext(over: Partial<AIContext['page']> = {}): AIContext {
  return {
    contextVersion: 'opportunity-context-v1',
    project: { name: 'P' },
    website: { baseUrl: 'https://site.example.com', blogPathPrefix: null },
    opportunity: {
      id: 'o1',
      type: 'LOW_CTR',
      score: 70,
      status: 'DETECTED',
      dateRange: { start: '2026-09-01', end: '2026-09-28' },
      scoreBreakdown: [],
      metrics: {
        current: { start: '2026-09-01', end: '2026-09-28', clicks: 300, impressions: 30000, ctr: 0.01, position: 7.2 },
        previous: { start: '2026-08-04', end: '2026-08-31', clicks: 310, impressions: 29000, ctr: 0.0107, position: 7 },
        expectedCtr: 0.038,
        queryCount: 3,
        clickChangePercent: -3.2,
        ctrChangePercent: -6.5,
        positionChange: 0.2,
      },
      evidence: [],
      topQueries: [
        { query: 'react guide', clicks: 120, impressions: 12000, ctr: 0.01, position: 6.5 },
        { query: 'React Performance', clicks: 10, impressions: 3000, ctr: 0.003, position: 9 },
      ],
    },
    page: {
      url: 'https://site.example.com/blog/react-guide',
      status: 'ACTIVE',
      lastCrawledAt: '2026-10-01T00:00:00.000Z',
      content: {
        versionId: 'v1',
        versionNo: 1,
        title: 'React Guide',
        metaDescription: null,
        canonicalUrl: null,
        language: 'en',
        robotsMeta: null,
        h1: 'React Guide',
        headings: [{ level: 2, text: 'React hooks tutorial' }],
        wordCount: 900,
        sections: [{ sectionKey: 's1-react-hooks-tutorial', heading: 'React hooks tutorial', level: 2, wordCount: 400, text: 'Hooks...', truncated: false }],
        internalLinks: [],
        internalLinkCount: 0,
        structuredDataTypes: [],
        imagesMissingAlt: 0,
        extractionMethod: 'HTTP_CHEERIO',
        contentTruncated: false,
      },
      ...over,
    },
  };
}
