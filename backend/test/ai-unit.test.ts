import { describe, expect, it } from 'vitest';
import { aiConfig, AINotConfiguredError } from '../src/services/ai/ai.config.js';
import { checkAnalysis, checkRecommendations } from '../src/services/ai/ai.guardrails.js';
import { ContentGap, OpportunityAnalysis, Recommendation, RecommendationSet, SearchIntent } from '../src/services/ai/ai.schemas.js';
import {
  ANALYSIS_PROMPT_VERSION,
  buildOpportunityAnalysisMessage,
  OPPORTUNITY_ANALYSIS_PROMPT_VERSION,
  OPPORTUNITY_ANALYSIS_SYSTEM,
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_SYSTEM,
} from '../src/services/ai/prompts/index.js';
import { sampleContext as ctx, validAnalysis, validRecommendations } from './ai-fixtures.js';

const KEY = 'sk-or-v1-test-secret-key-0123456789';


describe('configuration', () => {
  const base = { AI_PROVIDER: 'openrouter' as const, GEMINI_API_KEY: undefined, OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1', AI_MAX_TOKENS: 16000, AI_TIMEOUT_MS: 60000, AI_MAX_RETRIES: 1, AI_REASONING_EFFORT: undefined, AI_OUTPUT_MODE: 'json_schema' as const };

  it('requires an OpenRouter key and a model, without echoing secrets', () => {
    expect(() => aiConfig({ ...base, OPENROUTER_API_KEY: undefined, AI_MODEL: 'anthropic/some-model' })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => aiConfig({ ...base, OPENROUTER_API_KEY: undefined, AI_MODEL: 'anthropic/some-model' })).toThrow(AINotConfiguredError);
    expect(() => aiConfig({ ...base, OPENROUTER_API_KEY: KEY, AI_MODEL: undefined })).toThrow(/AI_MODEL/);
    try {
      aiConfig({ ...base, OPENROUTER_API_KEY: KEY, AI_MODEL: undefined });
    } catch (e) {
      expect((e as Error).message).not.toContain(KEY);
    }
  });

  it('builds the config from env values (model is never hardcoded)', () => {
    expect(aiConfig({ ...base, OPENROUTER_API_KEY: KEY, AI_MODEL: 'some-model' })).toMatchObject({
      model: 'some-model',
      baseUrl: 'https://openrouter.ai/api/v1',
      maxTokens: 16000,
      maxRetries: 1,
      reasoningEffort: null,
    });
  });
});

describe('prompt versioning', () => {
  it('exposes stable version ids recorded on every run', () => {
    expect(OPPORTUNITY_ANALYSIS_PROMPT_VERSION).toBe('opportunity-analysis-v1');
    expect(RECOMMENDATION_PROMPT_VERSION).toBe('recommendation-v1');
    expect(ANALYSIS_PROMPT_VERSION).toBe('opportunity-analysis-v1+recommendation-v1');
  });

  it('prompts carry the evidence and safety rules', () => {
    for (const p of [OPPORTUNITY_ANALYSIS_SYSTEM, RECOMMENDATION_SYSTEM]) {
      expect(p).toContain('Do not say a change will improve rankings');
      expect(p).toContain('untrusted data');
      expect(p).toContain('observations');
    }
    expect(RECOMMENDATION_SYSTEM).toContain('do not propose a new article');
  });

  it('puts context in the user message as data', () => {
    const msg = buildOpportunityAnalysisMessage(ctx());
    expect(msg).toContain('<page>');
    expect(msg).toContain('"react guide"');
    expect(msg).toContain('s1-react-hooks-tutorial');
  });
});

describe('schemas', () => {
  it('accepts a valid analysis and recommendation set', () => {
    expect(OpportunityAnalysis.safeParse(validAnalysis()).success).toBe(true);
    expect(RecommendationSet.safeParse(validRecommendations()).success).toBe(true);
  });

  it('rejects an unknown intent and out-of-range confidence', () => {
    expect(SearchIntent.safeParse({ query: 'x', intent: 'CURIOUS', confidence: 0.5, reasoning: 'r' }).success).toBe(false);
    expect(SearchIntent.safeParse({ query: 'x', intent: 'MIXED', confidence: 1.5, reasoning: 'r' }).success).toBe(false);
    expect(SearchIntent.safeParse({ query: 'x', intent: 'UNKNOWN', confidence: 0.2, reasoning: 'ambiguous' }).success).toBe(true);
  });

  it('requires evidence on observations, gaps and recommendations', () => {
    expect(OpportunityAnalysis.safeParse(validAnalysis({ observations: [{ type: 'CTR', statement: 's', evidence: [] }] })).success).toBe(false);
    expect(ContentGap.safeParse({ topic: 't', relatedQueries: [], evidence: 'e', confidence: 0.5 }).success).toBe(false);
    const rec = validRecommendations().recommendations[0]!;
    expect(Recommendation.safeParse({ ...rec, evidence: [] }).success).toBe(false);
    expect(Recommendation.safeParse({ ...rec, type: 'PUBLISH' }).success).toBe(false);
    expect(Recommendation.safeParse({ ...rec, type: 'NEW_ARTICLE' }).success).toBe(false);
  });

  it('requires at least one observation', () => {
    expect(OpportunityAnalysis.safeParse(validAnalysis({ observations: [] })).success).toBe(false);
  });
});

describe('guardrails', () => {
  it('passes grounded output (query matching ignores case and spacing)', () => {
    expect(checkAnalysis(ctx(), validAnalysis())).toEqual([]);
    expect(checkRecommendations(ctx(), validRecommendations())).toEqual([]);
  });

  it('rejects queries that are not in the GSC data', () => {
    const a = validAnalysis({ searchIntent: [{ query: 'vue tutorial', intent: 'INFORMATIONAL', confidence: 0.9, reasoning: 'r' }] });
    expect(checkAnalysis(ctx(), a).join()).toMatch(/not in the data/);
    const g = validAnalysis({ contentGaps: [{ topic: 't', relatedQueries: ['made up query'], evidence: 'e', confidence: 0.5 }] });
    expect(checkAnalysis(ctx(), g).join()).toMatch(/unknown query/);
  });

  it('rejects promissory or certain causal language', () => {
    const a = validAnalysis({ summary: 'Adding a profiling section will increase rankings.' });
    expect(checkAnalysis(ctx(), a).join()).toMatch(/forbidden wording/);
    const r = validRecommendations({ caveats: ['This change is guaranteed to help.'] });
    expect(checkRecommendations(ctx(), r).join()).toMatch(/forbidden wording/);
    expect(checkAnalysis(ctx(), validAnalysis({ summary: 'This is definitely why the page underperforms.' })).length).toBeGreaterThan(0);
  });

  it('allows clearly negated guarantee wording in disclaimers', () => {
    for (const ok of [
      'Results are not guaranteed.',
      'There is no guarantee that rankings change.',
      'We cannot guarantee any CTR change.',
      'Search Console shows correlation; outcomes are not guaranteed and may vary.',
      "Changes can't guarantee traffic.",
      'This is not a guarantee of improvement.',
    ]) {
      expect(checkRecommendations(ctx(), validRecommendations({ caveats: [ok] }))).toEqual([]);
    }
  });

  it('still rejects positive or unqualified guarantees and other overclaims', () => {
    for (const bad of [
      'This change is guaranteed to improve CTR.',
      'A new title guarantees more clicks.',
      'Expect a guaranteed increase in traffic.',
      'Guaranteed results.',
      'Results are not guaranteed, but this rewrite guarantees higher rankings.', // second mention is un-negated
      'This will definitely help.',
      'Rankings will increase after this change.',
      'The page is certain to rank higher.',
      'This will result in more traffic.',
    ]) {
      expect(checkRecommendations(ctx(), validRecommendations({ caveats: [bad] })).length, bad).toBeGreaterThan(0);
    }
  });

  it('rejects recommendations for sections that do not exist', () => {
    const r = validRecommendations();
    r.recommendations[1]!.targetSection = 's9-invented';
    expect(checkRecommendations(ctx(), r).join()).toMatch(/unknown section/);
  });

  it('requires an insufficient-evidence answer when there is no crawled content', () => {
    const noContent = ctx({ content: null });
    expect(checkAnalysis(noContent, validAnalysis()).length).toBeGreaterThan(0);
    const honest = validAnalysis({ evidenceSufficient: false, insufficientEvidenceNotes: ['No crawled content.'], contentGaps: [] });
    expect(checkAnalysis(noContent, honest)).toEqual([]);
  });
});
