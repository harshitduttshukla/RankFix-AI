import { ApiError, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { AIConfig } from './ai.config.js';
import { AIError, type AIUsage } from './ai.errors.js';
import type { AIContext } from './ai-context.builder.js';
import type { AIProvider, AIResult } from './ai.provider.js';
import { DraftOutput, OpportunityAnalysis, type Recommendation, RecommendationSet } from './ai.schemas.js';
import {
  buildDraftMessage,
  buildOpportunityAnalysisMessage,
  DRAFT_PROMPT_VERSION,
  DRAFT_SYSTEM,
  buildRecommendationMessage,
  OPPORTUNITY_ANALYSIS_PROMPT_VERSION,
  OPPORTUNITY_ANALYSIS_SYSTEM,
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_SYSTEM,
} from './prompts/index.js';

/*
 * Google Gemini API (Google AI Studio key) via the official @google/genai SDK. The only file that knows Gemini
 * details. Native structured output (responseMimeType application/json + responseJsonSchema generated from the
 * Zod schemas); the response is still re-validated with Zod here and grounding-checked by the Phase 5 service.
 *
 * Retries: the SDK's own HTTP retry is disabled (attempts: 1). Errors come back normalized as retryable or
 * permanent AIErrors and the existing BullMQ job retry is the single retry layer.
 */

/** The slice of the SDK this provider uses; tests inject a fake. */
export interface GeminiModels {
  generateContent(params: {
    model: string;
    contents: string;
    config: Record<string, unknown>;
  }): Promise<GeminiResponse>;
}

/** Response fields read by this provider (a structural subset of the SDK's GenerateContentResponse). */
export interface GeminiResponse {
  text?: string;
  modelVersion?: string;
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
}

/**
 * JSON Schema keywords removed for Gemini: string length/pattern/format are undocumented, and minItems/maxItems
 * are rejected with HTTP 400 INVALID_ARGUMENT by current models (verified against gemini-3.8-flash). Array limits
 * are restated in `description` so the model still sees them; numeric minimum/maximum are accepted and kept.
 * Zod enforces every limit on re-validation regardless.
 */
const UNSUPPORTED = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems']);

function itemLimits(node: Record<string, unknown>): string | null {
  const min = typeof node.minItems === 'number' ? node.minItems : null;
  const max = typeof node.maxItems === 'number' ? node.maxItems : null;
  if (min != null && max != null) return `Between ${min} and ${max} items.`;
  if (max != null) return `At most ${max} items.`;
  if (min != null) return `At least ${min} item${min === 1 ? '' : 's'}.`;
  return null;
}

export function toGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out = Object.fromEntries(Object.entries(obj).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, strip(v)]));
    const limits = itemLimits(obj);
    if (limits) out.description = typeof obj.description === 'string' ? `${obj.description} ${limits}` : limits;
    return out;
  };
  return strip(z.toJSONSchema(schema, { io: 'output' })) as Record<string, unknown>;
}

const REFUSAL_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly models: GeminiModels;

  constructor(
    private readonly cfg: AIConfig,
    models?: GeminiModels,
  ) {
    this.model = cfg.model;
    this.models =
      models ??
      (new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions: { retryOptions: { attempts: 1 } } }).models as unknown as GeminiModels);
  }

  analyzeOpportunity(context: AIContext): Promise<AIResult<OpportunityAnalysis>> {
    return this.call(OpportunityAnalysis, OPPORTUNITY_ANALYSIS_PROMPT_VERSION, OPPORTUNITY_ANALYSIS_SYSTEM, buildOpportunityAnalysisMessage(context));
  }

  generateRecommendation(context: AIContext, analysis: OpportunityAnalysis): Promise<AIResult<RecommendationSet>> {
    return this.call(RecommendationSet, RECOMMENDATION_PROMPT_VERSION, RECOMMENDATION_SYSTEM, buildRecommendationMessage(context, analysis));
  }

  generateDraft(context: AIContext, recommendation: Recommendation, previousDrafts: string[]): Promise<AIResult<DraftOutput>> {
    return this.call(DraftOutput, DRAFT_PROMPT_VERSION, DRAFT_SYSTEM, buildDraftMessage(context, recommendation, previousDrafts));
  }

  private async call<S extends z.ZodType>(schema: S, promptVersion: string, system: string, user: string): Promise<AIResult<z.infer<S>>> {
    const started = Date.now();
    const signal = AbortSignal.timeout(this.cfg.timeoutMs);
    let res: GeminiResponse;
    try {
      res = await this.models.generateContent({
        model: this.cfg.model,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: toGeminiJsonSchema(schema),
          maxOutputTokens: this.cfg.maxTokens,
          abortSignal: signal,
        },
      });
    } catch (err) {
      throw toGeminiError(err, signal.aborted, this.cfg.timeoutMs);
    }

    const usage: AIUsage = {
      inputTokens: num(res.usageMetadata?.promptTokenCount),
      // Thinking tokens are billed as output; both are real counts from the API (never estimated).
      outputTokens:
        num(res.usageMetadata?.candidatesTokenCount) == null && num(res.usageMetadata?.thoughtsTokenCount) == null
          ? null
          : (num(res.usageMetadata?.candidatesTokenCount) ?? 0) + (num(res.usageMetadata?.thoughtsTokenCount) ?? 0),
    };

    if (res.promptFeedback?.blockReason) throw new AIError('AI_REFUSED', 'The AI provider blocked the request (safety)', false, usage);
    const candidate = res.candidates?.[0];
    if (!candidate) throw new AIError('AI_OUTPUT_INVALID', 'AI provider returned no candidates', false, usage);
    const finish = candidate.finishReason ?? 'STOP';
    if (REFUSAL_FINISH.has(finish)) throw new AIError('AI_REFUSED', 'The model declined to answer (safety)', false, usage);
    if (finish === 'MAX_TOKENS') throw new AIError('AI_TRUNCATED', 'Model output hit the max_tokens limit before completing', false, usage);

    // Answer text only (thought parts excluded).
    const text = res.text ?? candidate.content?.parts?.filter((p) => !p.thought && p.text).map((p) => p.text).join('');
    if (!text || !text.trim()) throw new AIError('AI_OUTPUT_INVALID', 'AI provider returned an empty response', false, usage);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
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
    return { output: checked.data as z.infer<S>, usage, model: res.modelVersion ?? this.cfg.model, promptVersion, latencyMs: Date.now() - started };
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Gemini/SDK error → normalized AIError. Messages are our own wording; SDK messages can echo request
 * details, so they are only used for classification, never stored or returned.
 */
export function toGeminiError(err: unknown, timedOut = false, timeoutMs = 0): AIError {
  if (err instanceof AIError) return err;
  if (timedOut || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
    return new AIError('AI_TIMEOUT', `AI provider did not respond within ${timeoutMs} ms`, true);
  }
  const status = err instanceof ApiError ? err.status : typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
  const msg = err instanceof Error ? err.message : String(err);
  if (status == null) {
    if (err instanceof SyntaxError) return new AIError('AI_OUTPUT_INVALID', 'AI provider returned a malformed response', false);
    return new AIError('AI_PROVIDER_UNAVAILABLE', 'Could not reach the AI provider', true);
  }
  if (/API key not valid|API_KEY_INVALID|API key expired|PERMISSION_DENIED|unregistered callers/i.test(msg) || status === 401 || status === 403) {
    return new AIError('AI_AUTHENTICATION_FAILED', 'AI provider authentication failed', false);
  }
  if (status === 429) {
    // Daily free-tier quotas won't recover within the job's retry window; per-minute limits will.
    if (/per.?day|PerDay|daily/i.test(msg)) return new AIError('AI_QUOTA_EXCEEDED', 'The AI provider daily quota is exhausted', false);
    return new AIError('AI_RATE_LIMITED', 'The AI provider rate limit was reached', true);
  }
  if (status === 404 || /models\/[^ ]+ is not found|not supported for generateContent|model.*not found/i.test(msg)) {
    return new AIError('AI_MODEL_NOT_FOUND', 'The configured AI model is not available to this API key (check AI_MODEL)', false);
  }
  if (status === 400) return new AIError('AI_BAD_REQUEST', 'The AI provider rejected the request', false);
  if (status === 408 || status === 504) return new AIError('AI_TIMEOUT', 'The AI provider timed out', true);
  if (status >= 500) return new AIError('AI_PROVIDER_UNAVAILABLE', 'The AI model or provider is temporarily unavailable', true);
  return new AIError('AI_BAD_REQUEST', `The AI provider returned HTTP ${status}`, false);
}
