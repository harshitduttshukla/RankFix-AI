import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { aiConfig, AINotConfiguredError, type AIConfig } from '../src/services/ai/ai.config.js';
import { AIError } from '../src/services/ai/ai.errors.js';
import { checkAnalysis, checkRecommendations } from '../src/services/ai/ai.guardrails.js';
import { ContentGap, OpportunityAnalysis, Recommendation, RecommendationSet, SearchIntent } from '../src/services/ai/ai.schemas.js';
import type { AIContext } from '../src/services/ai/ai-context.builder.js';
import { AnthropicProvider, toAIError } from '../src/services/ai/anthropic.provider.js';
import {
  ANALYSIS_PROMPT_VERSION,
  buildOpportunityAnalysisMessage,
  OPPORTUNITY_ANALYSIS_PROMPT_VERSION,
  OPPORTUNITY_ANALYSIS_SYSTEM,
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_SYSTEM,
} from '../src/services/ai/prompts/index.js';
import { validAnalysis, validRecommendations } from './ai-fixtures.js';

const KEY = 'sk-ant-test-secret-key-0123456789';
const CFG: AIConfig = { apiKey: KEY, model: 'claude-opus-5-5', maxTokens: 16000, timeoutMs: 60000, maxRetries: 2, effort: 'high', refusalFallback: true };

function ctx(over: Partial<AIContext['page']> = {}): AIContext {
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

describe('configuration', () => {
  const base = { AI_MAX_TOKENS: 16000, AI_TIMEOUT_MS: 60000, AI_MAX_RETRIES: 2, AI_EFFORT: 'high' as const, AI_REFUSAL_FALLBACK: true };

  it('requires an API key and a model, without echoing secrets', () => {
    expect(() => aiConfig({ ...base, ANTHROPIC_API_KEY: undefined, AI_MODEL: 'claude-opus-5-5' })).toThrow(AINotConfiguredError);
    expect(() => aiConfig({ ...base, ANTHROPIC_API_KEY: KEY, AI_MODEL: undefined })).toThrow(/AI_MODEL/);
    try {
      aiConfig({ ...base, ANTHROPIC_API_KEY: KEY, AI_MODEL: undefined });
    } catch (e) {
      expect((e as Error).message).not.toContain(KEY);
    }
  });

  it('builds the config from env values (model is never hardcoded)', () => {
    expect(aiConfig({ ...base, ANTHROPIC_API_KEY: KEY, AI_MODEL: 'some-model' })).toMatchObject({ model: 'some-model', maxTokens: 16000, maxRetries: 2 });
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

/** Minimal stand-in for the SDK client: only beta.messages.parse is used by the provider. */
function mockClient(impl: (params: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = { beta: { messages: { parse: async (params: Record<string, unknown>) => (calls.push(params), impl(params)) } } };
  return { client: client as unknown as Anthropic, calls };
}
const reply = (parsed: unknown, stop_reason = 'end_turn', extra: object = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason,
  parsed_output: parsed,
  usage: { input_tokens: 1234, output_tokens: 321 },
  ...extra,
});

describe('AnthropicProvider', () => {
  it('sends a structured-output request built from config and returns validated output with usage', async () => {
    const { client, calls } = mockClient(() => reply(validAnalysis()));
    const p = new AnthropicProvider(CFG, client);
    const res = await p.analyzeOpportunity(ctx());
    expect(res.output.summary).toBeTruthy();
    expect(res.usage).toEqual({ inputTokens: 1234, outputTokens: 321 });
    expect(res.promptVersion).toBe('opportunity-analysis-v1');
    const req = calls[0]!;
    expect(req).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect((req.output_config as { effort: string; format: unknown }).effort).toBe('high');
    expect((req.output_config as { format: unknown }).format).toBeTruthy();
    expect(req.system).toBe(OPPORTUNITY_ANALYSIS_SYSTEM);
    expect(JSON.stringify(req)).not.toContain(KEY);
  });

  it('omits the fallback beta when disabled', async () => {
    const { client, calls } = mockClient(() => reply(validRecommendations()));
    await new AnthropicProvider({ ...CFG, refusalFallback: false }, client).generateRecommendation(ctx(), validAnalysis());
    expect(calls[0]).not.toHaveProperty('fallbacks');
  });

  it('rejects schema-invalid output as AI_OUTPUT_INVALID (not retryable)', async () => {
    const { client } = mockClient(() => reply({ ...validAnalysis(), observations: [] }));
    await expect(new AnthropicProvider(CFG, client).analyzeOpportunity(ctx())).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID', retryable: false });
    const { client: c2 } = mockClient(() => reply(null));
    await expect(new AnthropicProvider(CFG, c2).analyzeOpportunity(ctx())).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });

  it('maps refusal and truncation to permanent errors, keeping usage', async () => {
    const { client } = mockClient(() => reply(null, 'refusal', { stop_details: { type: 'refusal', category: 'cyber' } }));
    await expect(new AnthropicProvider(CFG, client).analyzeOpportunity(ctx())).rejects.toMatchObject({ code: 'AI_REFUSED', retryable: false, usage: { inputTokens: 1234 } });
    const { client: c2 } = mockClient(() => reply(null, 'max_tokens'));
    await expect(new AnthropicProvider(CFG, c2).analyzeOpportunity(ctx())).rejects.toMatchObject({ code: 'AI_TRUNCATED', retryable: false });
  });

  it('classifies SDK errors as retryable or permanent', () => {
    const h = new Headers();
    expect(toAIError(new Anthropic.RateLimitError(429, {}, 'rate limited', h))).toMatchObject({ code: 'PROVIDER_RETRYABLE', retryable: true });
    expect(toAIError(new Anthropic.InternalServerError(529, {}, 'overloaded', h))).toMatchObject({ retryable: true });
    expect(toAIError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ retryable: true });
    expect(toAIError(new Anthropic.AuthenticationError(401, {}, 'bad key', h))).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false });
    expect(toAIError(new Anthropic.BadRequestError(400, {}, 'bad', h))).toMatchObject({ retryable: false });
    expect(toAIError(new SyntaxError('Unexpected token'))).toMatchObject({ code: 'AI_OUTPUT_INVALID', retryable: false });
    expect(toAIError(new AIError('AI_REFUSED', 'x', false))).toMatchObject({ code: 'AI_REFUSED' });
  });

  it('propagates provider errors through the provider as AIErrors', async () => {
    const { client } = mockClient(() => {
      throw new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers());
    });
    await expect(new AnthropicProvider(CFG, client).analyzeOpportunity(ctx())).rejects.toBeInstanceOf(AIError);
  });
});
