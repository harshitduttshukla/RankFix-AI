import { ApiError } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { aiConfig, AINotConfiguredError, type AIConfig } from '../src/services/ai/ai.config.js';
import { AIError } from '../src/services/ai/ai.errors.js';
import { createAIProvider } from '../src/services/ai/ai.provider.js';
import { OpportunityAnalysis } from '../src/services/ai/ai.schemas.js';
import { GeminiProvider, toGeminiError, toGeminiJsonSchema, type GeminiModels, type GeminiResponse } from '../src/services/ai/gemini.provider.js';
import { OpenRouterProvider } from '../src/services/ai/openrouter.provider.js';
import { DRAFT_SYSTEM, OPPORTUNITY_ANALYSIS_SYSTEM, RECOMMENDATION_SYSTEM } from '../src/services/ai/prompts/index.js';
import { sampleContext, validAnalysis, validRecommendations } from './ai-fixtures.js';

const KEY = 'AIzaSyUnitTestGeminiKey-0123456789abcdef';
const CFG: AIConfig = {
  provider: 'gemini',
  apiKey: KEY,
  model: 'gemini-test-model',
  maxTokens: 16000,
  timeoutMs: 5000,
  maxRetries: 1,
  baseUrl: 'https://openrouter.ai/api/v1',
  outputMode: 'json_schema',
  reasoningEffort: null,
};

type Params = Parameters<GeminiModels['generateContent']>[0];
function mockModels(...steps: (GeminiResponse | Error)[]) {
  const calls: Params[] = [];
  const models: GeminiModels = {
    async generateContent(params) {
      calls.push(params);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { models, calls };
}
const ok = (body: unknown, extra: Partial<GeminiResponse> = {}): GeminiResponse => ({
  text: typeof body === 'string' ? body : JSON.stringify(body),
  modelVersion: 'gemini-test-model-001',
  candidates: [{ finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 700, thoughtsTokenCount: 300, totalTokenCount: 3100 },
  ...extra,
});
const apiError = (status: number, message: string) => new ApiError({ status, message });
const provider = (m: GeminiModels, cfg: Partial<AIConfig> = {}) => new GeminiProvider({ ...CFG, ...cfg }, m);
const reject = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection'); }, (e: AIError) => e);

describe('GeminiProvider request', () => {
  it('sends the configured model, existing prompts and a native JSON schema', async () => {
    const { models, calls } = mockModels(ok(validAnalysis()));
    await provider(models).analyzeOpportunity(sampleContext());
    const c = calls[0]!;
    expect(c.model).toBe('gemini-test-model');
    expect(c.contents).toContain('<page>');
    expect(c.config).toMatchObject({ systemInstruction: OPPORTUNITY_ANALYSIS_SYSTEM, responseMimeType: 'application/json', maxOutputTokens: 16000 });
    expect(c.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(c.config.responseJsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(c)).not.toContain(KEY);
  });

  it('drops keywords Gemini rejects, restating array limits in descriptions; keeps numeric limits', () => {
    const schema = toGeminiJsonSchema(OpportunityAnalysis) as { properties: Record<string, { description?: string }> };
    const s = JSON.stringify(schema);
    expect(s).not.toMatch(/minItems|maxItems|minLength|maxLength|\$schema/);
    expect(schema.properties.observations!.description).toBe('Between 1 and 12 items.');
    expect(schema.properties.searchIntent!.description).toBe('At most 15 items.');
    expect(s).toContain('"maximum":1');
    expect(s).toContain('"additionalProperties":false');
  });
});

describe('GeminiProvider responses', () => {
  it('returns a validated analysis with mapped usage and the served model version', async () => {
    const { models } = mockModels(ok(validAnalysis()));
    const r = await provider(models).analyzeOpportunity(sampleContext());
    expect(r.output).toEqual(validAnalysis());
    expect(r.usage).toEqual({ inputTokens: 2100, outputTokens: 1000 }); // candidates + thoughts
    expect(r.model).toBe('gemini-test-model-001');
    expect(r.promptVersion).toBe('opportunity-analysis-v1');
  });

  it('returns validated recommendations with the recommendation prompt', async () => {
    const { models, calls } = mockModels(ok(validRecommendations()));
    const r = await provider(models).generateRecommendation(sampleContext(), validAnalysis());
    expect(r.output.recommendations).toHaveLength(2);
    expect(calls[0]!.config.systemInstruction).toBe(RECOMMENDATION_SYSTEM);
  });

  it('returns a validated draft with the draft prompt and rejects malformed ones', async () => {
    const { models, calls } = mockModels(ok({ suggestedValue: null, note: 'Not enough page facts.' }), ok({ note: 'missing value' }));
    const rec = validRecommendations().recommendations[0]!;
    const r = await provider(models).generateDraft(sampleContext(), rec, []);
    expect(r.output).toEqual({ suggestedValue: null, note: 'Not enough page facts.' });
    expect(r.promptVersion).toBe('draft-v1');
    expect(calls[0]!.config.systemInstruction).toBe(DRAFT_SYSTEM);
    await expect(provider(models).generateDraft(sampleContext(), rec, [])).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });

  it('records null usage when usageMetadata is missing (never fabricated)', async () => {
    const { models } = mockModels(ok(validAnalysis(), { usageMetadata: undefined }));
    expect((await provider(models).analyzeOpportunity(sampleContext())).usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it.each([
    ['malformed JSON', ok('{"summary": "cut')],
    ['schema-invalid output', ok({ ...validAnalysis(), observations: [] })],
    ['a limit the schema states but the model ignored', ok(validAnalysis({ searchIntent: Array.from({ length: 16 }, () => ({ query: 'react guide', intent: 'MIXED' as const, confidence: 0.5, reasoning: 'r' })) }))],
    ['empty text', ok('')],
    ['no candidates', { usageMetadata: { promptTokenCount: 10 } } as GeminiResponse],
  ])('rejects %s as AI_OUTPUT_INVALID (not retryable)', async (_n, res) => {
    const { models, calls } = mockModels(res);
    expect(await reject(provider(models).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_OUTPUT_INVALID', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it.each(['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST', 'SPII'])('maps finishReason %s to AI_REFUSED', async (finishReason) => {
    const { models } = mockModels(ok(validAnalysis(), { candidates: [{ finishReason }] }));
    expect(await reject(provider(models).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_REFUSED', retryable: false });
  });

  it('maps a blocked prompt (promptFeedback.blockReason) to AI_REFUSED', async () => {
    const { models } = mockModels({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 50 } });
    expect(await reject(provider(models).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_REFUSED', usage: { inputTokens: 50 } });
  });

  it('maps finishReason MAX_TOKENS to AI_TRUNCATED', async () => {
    const { models } = mockModels(ok('{"summary":"cut', { candidates: [{ finishReason: 'MAX_TOKENS' }] }));
    expect(await reject(provider(models).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_TRUNCATED', retryable: false });
  });

  it('ignores thought parts when text is assembled from parts', async () => {
    const res: GeminiResponse = {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(validAnalysis()) }] } }],
    };
    const { models } = mockModels(res);
    expect((await provider(models).analyzeOpportunity(sampleContext())).output.summary).toBe(validAnalysis().summary);
  });
});

describe('GeminiProvider errors (no internal retries)', () => {
  it.each([
    [400, 'API key not valid. Please pass a valid API key.', 'AI_AUTHENTICATION_FAILED', false],
    [403, 'PERMISSION_DENIED', 'AI_AUTHENTICATION_FAILED', false],
    [404, 'models/gemini-nope is not found for API version v1beta, or is not supported for generateContent.', 'AI_MODEL_NOT_FOUND', false],
    [400, 'Invalid JSON payload received.', 'AI_BAD_REQUEST', false],
    [429, 'Resource has been exhausted: GenerateRequestsPerMinutePerProjectPerModel', 'AI_RATE_LIMITED', true],
    [429, 'You exceeded your current quota: GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'AI_QUOTA_EXCEEDED', false],
    [500, 'Internal error', 'AI_PROVIDER_UNAVAILABLE', true],
    [503, 'The model is overloaded. Please try again later.', 'AI_PROVIDER_UNAVAILABLE', true],
    [504, 'Deadline exceeded', 'AI_TIMEOUT', true],
  ])('HTTP %i (%s) → %s, retryable=%s, called once', async (status, message, code, retryable) => {
    const { models, calls } = mockModels(apiError(status, message));
    const e = await reject(provider(models).analyzeOpportunity(sampleContext()));
    expect(e).toMatchObject({ code, retryable });
    expect(calls).toHaveLength(1); // the job queue owns retries
  });

  it('aborts at AI_TIMEOUT_MS and reports a retryable AI_TIMEOUT', async () => {
    const hanging: GeminiModels = {
      generateContent: (p) =>
        new Promise((_res, rej) => (p.config.abortSignal as AbortSignal).addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    };
    expect(await reject(provider(hanging, { timeoutMs: 50 }).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_TIMEOUT', retryable: true });
  });

  it('maps a network failure to retryable AI_PROVIDER_UNAVAILABLE', async () => {
    const { models } = mockModels(new TypeError('fetch failed'));
    expect(await reject(provider(models).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('never puts the API key or raw SDK messages into errors', () => {
    for (const s of [400, 401, 403, 404, 429, 500, 503]) {
      const e = toGeminiError(apiError(s, `request with key=${KEY} failed`));
      expect(e).toBeInstanceOf(AIError);
      expect(e.message).not.toContain(KEY);
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });
});

describe('provider selection and configuration', () => {
  const base = { OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1', AI_MAX_TOKENS: 16000, AI_TIMEOUT_MS: 60000, AI_MAX_RETRIES: 1, AI_REASONING_EFFORT: undefined, AI_OUTPUT_MODE: 'json_schema' as const };

  it('AI_PROVIDER=gemini builds a GeminiProvider from GEMINI_API_KEY; openrouter still builds OpenRouterProvider', () => {
    const g = aiConfig({ ...base, AI_PROVIDER: 'gemini', GEMINI_API_KEY: KEY, OPENROUTER_API_KEY: undefined, AI_MODEL: 'gemini-test-model' });
    expect(g).toMatchObject({ provider: 'gemini', apiKey: KEY, model: 'gemini-test-model' });
    const gp = createAIProvider(g);
    expect(gp).toBeInstanceOf(GeminiProvider);
    expect(gp.name).toBe('gemini');

    const o = aiConfig({ ...base, AI_PROVIDER: 'openrouter', GEMINI_API_KEY: KEY, OPENROUTER_API_KEY: 'sk-or-v1-other-key-0123456789', AI_MODEL: 'vendor/m' });
    expect(o.apiKey).toBe('sk-or-v1-other-key-0123456789'); // never the other provider's key
    expect(createAIProvider(o)).toBeInstanceOf(OpenRouterProvider);
  });

  it('a missing GEMINI_API_KEY is reported by name without echoing values', () => {
    const run = () => aiConfig({ ...base, AI_PROVIDER: 'gemini', GEMINI_API_KEY: undefined, OPENROUTER_API_KEY: 'sk-or-v1-other-key-0123456789', AI_MODEL: 'gemini-test-model' });
    expect(run).toThrow(AINotConfiguredError);
    expect(run).toThrow(/GEMINI_API_KEY/);
    try {
      run();
    } catch (e) {
      expect((e as Error).message).not.toContain('sk-or-v1');
    }
  });
});
