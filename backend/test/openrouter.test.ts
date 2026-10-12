import { describe, expect, it } from 'vitest';
import type { AIConfig } from '../src/services/ai/ai.config.js';
import { AIError } from '../src/services/ai/ai.errors.js';
import { httpError, OpenRouterProvider, toStrictJsonSchema, type FetchLike } from '../src/services/ai/openrouter.provider.js';
import { OpportunityAnalysis } from '../src/services/ai/ai.schemas.js';
import { OPPORTUNITY_ANALYSIS_SYSTEM, RECOMMENDATION_SYSTEM } from '../src/services/ai/prompts/index.js';
import { sampleContext, validAnalysis, validRecommendations } from './ai-fixtures.js';

const KEY = 'sk-or-v1-unit-test-secret-0123456789abcdef';
const CFG: AIConfig = {
  provider: 'openrouter',
  apiKey: KEY,
  baseUrl: 'https://openrouter.example/api/v1/',
  model: 'vendor/some-model',
  maxTokens: 16000,
  timeoutMs: 5000,
  maxRetries: 1,
  outputMode: 'json_schema',
  reasoningEffort: null,
};

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** Scripted fetch: each call consumes the next step (the last repeats). */
function mockFetch(...steps: (Response | Error | (() => Response))[]) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step() : step.clone();
  };
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const completion = (content: unknown, extra: { finish_reason?: string; refusal?: string; usage?: object | null } = {}) =>
  json(200, {
    id: 'gen-1',
    model: 'vendor/some-model',
    choices: [{ finish_reason: extra.finish_reason ?? 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), refusal: extra.refusal ?? null } }],
    ...(extra.usage === null ? {} : { usage: extra.usage ?? { prompt_tokens: 1500, completion_tokens: 420, total_tokens: 1920 } }),
  });
const noSleep = async () => undefined;
const provider = (f: FetchLike, cfg: Partial<AIConfig> = {}) => new OpenRouterProvider({ ...CFG, ...cfg }, f, noSleep);
const reject = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection'); }, (e: AIError) => e);

describe('OpenRouterProvider request', () => {
  it('posts to {baseUrl}/chat/completions with bearer auth, the configured model and a strict JSON schema', async () => {
    const { fetchImpl, calls } = mockFetch(completion(validAnalysis()));
    await provider(fetchImpl).analyzeOpportunity(sampleContext());
    const c = calls[0]!;
    expect(c.url).toBe('https://openrouter.example/api/v1/chat/completions'); // trailing slash normalized
    expect(c.init.method).toBe('POST');
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(c.body.model).toBe('vendor/some-model');
    expect(c.body.max_tokens).toBe(16000);
    expect(c.body.provider).toEqual({ require_parameters: true });
    expect(c.body).not.toHaveProperty('models'); // no model fallback chain
    expect(c.body).not.toHaveProperty('reasoning');
    const messages = c.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: OPPORTUNITY_ANALYSIS_SYSTEM });
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('<page>');
    expect(messages.map((m) => m.content).join()).not.toContain(KEY); // the key never enters the prompt
    const rf = c.body.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema).toMatchObject({ name: 'opportunity_analysis', strict: true });
    expect(rf.json_schema.schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('prompt mode puts the schema in the system message and drops response_format / require_parameters', async () => {
    const { fetchImpl, calls } = mockFetch(completion(validAnalysis()));
    const r = await provider(fetchImpl, { outputMode: 'prompt' }).analyzeOpportunity(sampleContext());
    expect(r.output).toEqual(validAnalysis());
    const body = calls[0]!.body;
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('provider');
    const system = (body.messages as { content: string }[])[0]!.content;
    expect(system.startsWith(OPPORTUNITY_ANALYSIS_SYSTEM)).toBe(true); // versioned prompt unchanged, contract appended
    expect(system).toContain('JSON Schema:');
    expect(system).toContain('INFORMATIONAL');
    expect(system).toContain('"maxItems":6'); // prompt mode shows the model every limit
    expect(system).toContain('"maximum":1');
  });

  it('prompt mode still rejects schema-invalid output', async () => {
    const { fetchImpl } = mockFetch(completion('Sure! Here is the analysis: {"summary": "x"}'));
    expect(await reject(provider(fetchImpl, { outputMode: 'prompt' }).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });

  it('sends the unified reasoning effort only when configured', async () => {
    const { fetchImpl, calls } = mockFetch(completion(validAnalysis()));
    await provider(fetchImpl, { reasoningEffort: 'low' }).analyzeOpportunity(sampleContext());
    expect(calls[0]!.body.reasoning).toEqual({ effort: 'low', exclude: true });
  });

  it('strict schema strips length/range keywords but keeps structure (Zod still enforces them)', () => {
    const s = JSON.stringify(toStrictJsonSchema(OpportunityAnalysis));
    expect(s).not.toMatch(/minLength|maxLength|minItems|maxItems|"minimum"|"maximum"|\$schema/);
    expect(s).toContain('"additionalProperties":false');
    expect(s).toContain('INFORMATIONAL');
  });
});

describe('OpenRouterProvider responses', () => {
  it('returns a validated analysis with token usage and the served model', async () => {
    const { fetchImpl } = mockFetch(completion(validAnalysis()));
    const r = await provider(fetchImpl).analyzeOpportunity(sampleContext());
    expect(r.output).toEqual(validAnalysis());
    expect(r.usage).toEqual({ inputTokens: 1500, outputTokens: 420 });
    expect(r.model).toBe('vendor/some-model');
    expect(r.promptVersion).toBe('opportunity-analysis-v1');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns validated recommendations with the recommendation prompt', async () => {
    const { fetchImpl, calls } = mockFetch(completion(validRecommendations()));
    const r = await provider(fetchImpl).generateRecommendation(sampleContext(), validAnalysis());
    expect(r.output.recommendations).toHaveLength(2);
    expect(r.promptVersion).toBe('recommendation-v1');
    expect((calls[0]!.body.messages as { content: string }[])[0]!.content).toBe(RECOMMENDATION_SYSTEM);
    expect((calls[0]!.body.response_format as { json_schema: { name: string } }).json_schema.name).toBe('recommendation_set');
  });

  it('parses JSON wrapped in a markdown fence', async () => {
    const { fetchImpl } = mockFetch(completion('```json\n' + JSON.stringify(validAnalysis()) + '\n```'));
    expect((await provider(fetchImpl).analyzeOpportunity(sampleContext())).output.summary).toBe(validAnalysis().summary);
  });

  it('records null usage when the provider omits it (never fabricated)', async () => {
    const { fetchImpl } = mockFetch(completion(validAnalysis(), { usage: null }));
    expect((await provider(fetchImpl).analyzeOpportunity(sampleContext())).usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it.each([
    ['schema-invalid JSON', completion({ ...validAnalysis(), observations: [] })],
    ['an out-of-range confidence (stripped from the schema, still enforced by Zod)', completion(validAnalysis({ searchIntent: [{ query: 'react guide', intent: 'MIXED', confidence: 7, reasoning: 'r' }] }))],
    ['malformed JSON', completion('{"summary": "unterminated')],
    ['empty content', completion('')],
    ['no choices', json(200, { id: 'gen', choices: [] })],
    ['a non-JSON body', new Response('<html>oops</html>', { status: 200 })],
  ])('rejects %s as AI_OUTPUT_INVALID without retrying', async (_name, res) => {
    const { fetchImpl, calls } = mockFetch(res);
    const e = await reject(provider(fetchImpl).analyzeOpportunity(sampleContext()));
    expect(e).toBeInstanceOf(AIError);
    expect(e).toMatchObject({ code: 'AI_OUTPUT_INVALID', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('keeps usage on invalid output so the run records what was spent', async () => {
    const { fetchImpl } = mockFetch(completion({ nope: true }));
    expect(await reject(provider(fetchImpl).analyzeOpportunity(sampleContext()))).toMatchObject({ usage: { inputTokens: 1500, outputTokens: 420 } });
  });

  it('maps a model refusal (message.refusal / content_filter) to AI_REFUSED', async () => {
    const a = mockFetch(completion('', { refusal: 'I cannot help with that.', finish_reason: 'content_filter' }));
    expect(await reject(provider(a.fetchImpl).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_REFUSED', retryable: false });
    const b = mockFetch(completion(validAnalysis(), { finish_reason: 'content_filter' }));
    expect(await reject(provider(b.fetchImpl).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_REFUSED' });
  });

  it('maps truncation (finish_reason length) to AI_TRUNCATED', async () => {
    const { fetchImpl } = mockFetch(completion('{"summary":"cut', { finish_reason: 'length' }));
    expect(await reject(provider(fetchImpl).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_TRUNCATED', retryable: false });
  });

  it('treats an error object inside an HTTP 200 body as a failure', async () => {
    const { fetchImpl } = mockFetch(json(200, { error: { code: 502, message: 'upstream failed' } }), completion(validAnalysis()));
    const r = await provider(fetchImpl).analyzeOpportunity(sampleContext()); // 502 → retried once → succeeds
    expect(r.output.summary).toBeTruthy();
  });
});

describe('OpenRouterProvider errors and retries', () => {
  it.each([
    [401, { message: 'No auth credentials found' }, 'AI_AUTHENTICATION_FAILED'],
    [402, { message: 'Insufficient credits' }, 'AI_INSUFFICIENT_CREDITS'],
    [400, { message: 'vendor/nope is not a valid model ID' }, 'AI_MODEL_NOT_FOUND'],
    [404, { message: 'No endpoints found for vendor/nope' }, 'AI_MODEL_NOT_FOUND'],
    [503, { message: 'No allowed providers are available for the selected model that meet your routing requirements' }, 'AI_MODEL_NOT_FOUND'],
    [400, { message: 'Invalid messages' }, 'AI_BAD_REQUEST'],
    [403, { message: 'Input was flagged', metadata: { reasons: ['x'] } }, 'AI_REFUSED'],
  ])('HTTP %i is permanent (%s → %s) and never retried', async (status, error, code) => {
    const { fetchImpl, calls } = mockFetch(json(status, { error: { code: status, ...error } }));
    const e = await reject(provider(fetchImpl, { maxRetries: 3 }).analyzeOpportunity(sampleContext()));
    expect(e).toMatchObject({ code, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [429, 'AI_RATE_LIMITED'],
    [408, 'AI_TIMEOUT'],
    [500, 'AI_PROVIDER_UNAVAILABLE'],
    [502, 'AI_PROVIDER_UNAVAILABLE'],
    [503, 'AI_PROVIDER_UNAVAILABLE'],
  ])('HTTP %i is transient (%s): retried up to AI_MAX_RETRIES, then surfaced as retryable', async (status, code) => {
    const { fetchImpl, calls } = mockFetch(json(status, { error: { code: status, message: 'busy' } }));
    const e = await reject(provider(fetchImpl, { maxRetries: 2 }).analyzeOpportunity(sampleContext()));
    expect(e).toMatchObject({ code, retryable: true });
    expect(calls).toHaveLength(3);
  });

  it('recovers when a transient error is followed by success', async () => {
    const { fetchImpl, calls } = mockFetch(json(429, { error: { code: 429, message: 'slow down' } }), completion(validAnalysis()));
    expect((await provider(fetchImpl).analyzeOpportunity(sampleContext())).output.summary).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('maps a client-side timeout to retryable AI_TIMEOUT', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { fetchImpl, calls } = mockFetch(timeout);
    expect(await reject(provider(fetchImpl, { maxRetries: 0 }).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_TIMEOUT', retryable: true });
    expect(calls).toHaveLength(1);
  });

  it('actually aborts a request that exceeds AI_TIMEOUT_MS', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, rejectFn) => init.signal?.addEventListener('abort', () => rejectFn(init.signal!.reason as Error)));
    const p = new OpenRouterProvider({ ...CFG, timeoutMs: 50, maxRetries: 0 }, hang, noSleep);
    expect(await reject(p.analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_TIMEOUT' });
  });

  it('a timeout while reading a slow body is AI_TIMEOUT, not invalid output', async () => {
    const slowBody: FetchLike = async (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('\n   \n')); // OpenRouter keep-alive whitespace
          init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        },
      });
      return new Response(stream, { status: 200 });
    };
    const p = new OpenRouterProvider({ ...CFG, timeoutMs: 50, maxRetries: 0 }, slowBody, noSleep);
    expect(await reject(p.analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_TIMEOUT', retryable: true });
  });

  it('accepts a valid body preceded by keep-alive whitespace', async () => {
    const res = () => new Response('\n         \n' + JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validAnalysis()) } }] }), { status: 200 });
    const { fetchImpl } = mockFetch(res);
    expect((await provider(fetchImpl).analyzeOpportunity(sampleContext())).output.summary).toBeTruthy();
  });

  it('maps an overloaded upstream (503 inside a 200 body) to retryable AI_PROVIDER_UNAVAILABLE', async () => {
    const { fetchImpl } = mockFetch(json(200, { error: { message: 'Upstream error from Nvidia: Service temporarily overloaded', code: 503, metadata: { error_type: 'provider_overloaded' } } }));
    expect(await reject(provider(fetchImpl, { maxRetries: 0 }).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('maps a network failure to retryable AI_PROVIDER_UNAVAILABLE', async () => {
    const { fetchImpl } = mockFetch(new TypeError('fetch failed'));
    expect(await reject(provider(fetchImpl, { maxRetries: 0 }).analyzeOpportunity(sampleContext()))).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('never puts the API key or raw provider bodies into error messages', async () => {
    const leaky = { error: { code: 401, message: `Invalid key ${KEY}` } };
    const { fetchImpl } = mockFetch(json(401, leaky));
    const e = await reject(provider(fetchImpl).analyzeOpportunity(sampleContext()));
    expect(e.message).toBe('AI provider authentication failed');
    expect(JSON.stringify(e)).not.toContain(KEY);
    for (const s of [400, 402, 403, 429, 500, 502, 503]) expect(httpError(s, { message: `secret ${KEY}` }).message).not.toContain(KEY);
  });
});
