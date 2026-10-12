import { z } from 'zod';
import type { AIConfig } from './ai.config.js';
import { AIError, type AIErrorCode, type AIUsage } from './ai.errors.js';
import type { AIContext } from './ai-context.builder.js';
import type { AIProvider, AIResult } from './ai.provider.js';
import { OpportunityAnalysis, RecommendationSet } from './ai.schemas.js';
import {
  buildOpportunityAnalysisMessage,
  buildRecommendationMessage,
  OPPORTUNITY_ANALYSIS_PROMPT_VERSION,
  OPPORTUNITY_ANALYSIS_SYSTEM,
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_SYSTEM,
} from './prompts/index.js';

/*
 * OpenRouter (OpenAI-compatible Chat Completions) over plain fetch. Everything OpenRouter-specific stays in
 * this file; callers get the same validated objects and normalized AIErrors as from any other provider.
 *
 * Structured output: response_format json_schema (strict) generated from the Zod schemas, with
 * provider.require_parameters so OpenRouter only routes to endpoints that support it. The configured model is
 * never swapped for another model. Every response is still re-validated with Zod by this provider and then
 * grounding-checked by the Phase 5 service.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** JSON Schema keywords some strict-mode providers reject. Zod still enforces them on re-validation. */
const STRIP_KEYWORDS = new Set(['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format']);

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([k]) => !STRIP_KEYWORDS.has(k)).map(([k, v]) => [k, strip(v)]));
  };
  return strip(z.toJSONSchema(schema, { io: 'output' })) as Record<string, unknown>;
}

interface ChatCompletion {
  model?: string;
  choices?: { finish_reason?: string | null; native_finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: number | string; message?: string; metadata?: Record<string, unknown> };
}

export class OpenRouterProvider implements AIProvider {
  readonly name = 'openrouter';
  readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly cfg: AIConfig,
    fetchImpl?: FetchLike,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.model = cfg.model;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  analyzeOpportunity(context: AIContext): Promise<AIResult<OpportunityAnalysis>> {
    return this.call(OpportunityAnalysis, 'opportunity_analysis', OPPORTUNITY_ANALYSIS_PROMPT_VERSION, OPPORTUNITY_ANALYSIS_SYSTEM, buildOpportunityAnalysisMessage(context));
  }

  generateRecommendation(context: AIContext, analysis: OpportunityAnalysis): Promise<AIResult<RecommendationSet>> {
    return this.call(RecommendationSet, 'recommendation_set', RECOMMENDATION_PROMPT_VERSION, RECOMMENDATION_SYSTEM, buildRecommendationMessage(context, analysis));
  }

  /** Retries only transient errors, `maxRetries` times, inside one job attempt. */
  private async call<S extends z.ZodType>(schema: S, schemaName: string, promptVersion: string, system: string, user: string): Promise<AIResult<z.infer<S>>> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const { output, usage, model } = await this.once(schema, schemaName, system, user);
        return { output, usage, model, promptVersion, latencyMs: Date.now() - started };
      } catch (err) {
        const e = err instanceof AIError ? err : new AIError('PROVIDER_ERROR', 'Unexpected AI provider failure', false);
        if (!e.retryable || attempt >= this.cfg.maxRetries) throw e;
        await this.sleep(Math.min(1000 * 2 ** attempt, 8000));
      }
    }
  }

  private async once<S extends z.ZodType>(schema: S, schemaName: string, system: string, user: string) {
    const native = this.cfg.outputMode === 'json_schema';
    // Native strict mode gets the keyword-stripped schema; prompt mode shows the model every limit.
    const jsonSchema = native ? toStrictJsonSchema(schema) : fullJsonSchema(schema);
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: native ? system : `${system}\n\n${promptModeInstruction(jsonSchema)}` },
        { role: 'user', content: user },
      ],
      max_tokens: this.cfg.maxTokens,
      ...(native
        ? {
            response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: jsonSchema } },
            // Only endpoints that honor every parameter (incl. structured output); same model, no model fallback.
            provider: { require_parameters: true },
          }
        : {}),
      ...(this.cfg.reasoningEffort ? { reasoning: { effort: this.cfg.reasoningEffort, exclude: true } } : {}),
    };

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'BlogPilot',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      // Read the body inside the same try: the timeout can fire while OpenRouter is still streaming
      // keep-alive whitespace before a slow response, and that is a timeout, not invalid output.
      text = await res.text();
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AIError('AI_TIMEOUT', `AI provider did not respond within ${this.cfg.timeoutMs} ms`, true);
      }
      throw new AIError('AI_PROVIDER_UNAVAILABLE', 'Could not reach the AI provider', true);
    }

    let json: ChatCompletion | null = null;
    try {
      json = JSON.parse(text) as ChatCompletion; // leading keep-alive whitespace is valid JSON whitespace
    } catch {
      if (!res.ok) throw httpError(res.status, undefined);
      throw new AIError('AI_OUTPUT_INVALID', 'AI provider returned a non-JSON response', false);
    }
    if (!res.ok) throw httpError(res.status, json?.error);
    // A failure after headers were sent still arrives as HTTP 200 with an error body.
    if (json?.error) throw httpError(Number(json.error.code) || 502, json.error);

    const usage: AIUsage = {
      inputTokens: typeof json?.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : null,
      outputTokens: typeof json?.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : null,
    };
    const choice = json?.choices?.[0];
    if (!choice?.message) throw new AIError('AI_OUTPUT_INVALID', 'AI provider returned no choices', false, usage);
    if (choice.message.refusal || choice.finish_reason === 'content_filter') {
      throw new AIError('AI_REFUSED', 'The model declined the request', false, usage);
    }
    if (choice.finish_reason === 'length') throw new AIError('AI_TRUNCATED', 'Model output hit the max_tokens limit before completing', false, usage);
    if (choice.finish_reason === 'error') throw new AIError('AI_PROVIDER_UNAVAILABLE', 'The model provider failed while generating', true, usage);

    const content = choice.message.content;
    if (!content || !content.trim()) throw new AIError('AI_OUTPUT_INVALID', 'AI provider returned an empty response', false, usage);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(content));
    } catch {
      throw new AIError('AI_OUTPUT_INVALID', 'Model output was not valid JSON', false, usage);
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      throw new AIError(
        'AI_OUTPUT_INVALID',
        `Model output failed schema validation: ${checked.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        false,
        usage,
      );
    }
    return { output: checked.data as z.infer<S>, usage, model: json?.model ?? this.cfg.model };
  }
}

export function fullJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  return rest;
}

/** Output contract for models without structured-output support. The response is still Zod-validated. */
export function promptModeInstruction(jsonSchema: Record<string, unknown>) {
  return `Output format: respond with exactly one JSON object that conforms to the JSON Schema below. Output only the JSON object, with no text, explanation or code fence before or after it. Include every required field; use empty arrays when there is nothing to report. Respect every limit in the schema (maxItems, maxLength, minimum, maximum); the response is rejected if any limit is exceeded.

JSON Schema:
${JSON.stringify(jsonSchema)}`;
}

/** Some models wrap JSON in a ```json fence even in JSON mode. */
function stripFence(s: string) {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1]! : s.trim();
}

/**
 * OpenRouter HTTP status → normalized error. Messages are our own wording; raw provider bodies and
 * credentials are never included (they could reach the database or logs).
 */
export function httpError(status: number, error?: { message?: string; metadata?: Record<string, unknown> }): AIError {
  const msg = (error?.message ?? '').toLowerCase();
  const map = (code: AIErrorCode, message: string, retryable: boolean) => new AIError(code, message, retryable);
  switch (status) {
    case 400:
    case 404:
      if (/model|not a valid|no endpoints|not found/.test(msg)) {
        return map('AI_MODEL_NOT_FOUND', 'The configured AI model is not available on the AI provider (check AI_MODEL, and that it supports structured output)', false);
      }
      return map('AI_BAD_REQUEST', 'The AI provider rejected the request', false);
    case 401:
      return map('AI_AUTHENTICATION_FAILED', 'AI provider authentication failed', false);
    case 402:
      return map('AI_INSUFFICIENT_CREDITS', 'The AI provider account has insufficient credits', false);
    case 403:
      return map('AI_REFUSED', 'The AI provider blocked the request (moderation or guardrail)', false);
    case 408:
    case 504:
      return map('AI_TIMEOUT', 'The AI provider timed out', true);
    case 429:
      return map('AI_RATE_LIMITED', 'The AI provider rate limit was reached', true);
    case 503:
      if (/routing requirements|require_parameters|no endpoints/.test(msg)) {
        return map('AI_MODEL_NOT_FOUND', 'No provider for the configured AI model supports the required parameters (structured output)', false);
      }
      return map('AI_PROVIDER_UNAVAILABLE', 'The AI model or provider is temporarily unavailable', true);
    case 500:
    case 502:
      return map('AI_PROVIDER_UNAVAILABLE', 'The AI model or provider is temporarily unavailable', true);
    default:
      return map(status >= 500 ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_BAD_REQUEST', `The AI provider returned HTTP ${status}`, status >= 500);
  }
}
