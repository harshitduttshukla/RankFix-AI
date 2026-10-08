import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { AIConfig } from './ai.config.js';
import { AIError, type AIUsage } from './ai.errors.js';
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

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Claude via the official SDK. Everything Anthropic-specific stays in this file. */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(
    private readonly cfg: AIConfig,
    client?: Anthropic,
  ) {
    this.model = cfg.model;
    // SDK retries 408/409/429/5xx and connection errors with backoff; the job layer retries on top of that.
    this.client = client ?? new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: cfg.maxRetries });
  }

  analyzeOpportunity(context: AIContext): Promise<AIResult<OpportunityAnalysis>> {
    return this.call(OpportunityAnalysis, OPPORTUNITY_ANALYSIS_PROMPT_VERSION, OPPORTUNITY_ANALYSIS_SYSTEM, buildOpportunityAnalysisMessage(context));
  }

  generateRecommendation(context: AIContext, analysis: OpportunityAnalysis): Promise<AIResult<RecommendationSet>> {
    return this.call(RecommendationSet, RECOMMENDATION_PROMPT_VERSION, RECOMMENDATION_SYSTEM, buildRecommendationMessage(context, analysis));
  }

  private async call<S extends z.ZodType>(schema: S, promptVersion: string, system: string, user: string): Promise<AIResult<z.infer<S>>> {
    const started = Date.now();
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        // Adaptive thinking is the default on current models; effort sets depth.
        output_config: { effort: this.cfg.effort, format: betaZodOutputFormat(schema) },
        ...(this.cfg.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      });
    } catch (err) {
      throw toAIError(err);
    }

    const usage: AIUsage = { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
    if (response.stop_reason === 'refusal') {
      throw new AIError('AI_REFUSED', `Model declined the request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`, false, usage);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AIError('AI_TRUNCATED', 'Model output hit the max_tokens limit before completing', false, usage);
    }
    // Re-validate even though the SDK parsed: the schema carries limits structured outputs can't express.
    const checked = schema.safeParse(response.parsed_output);
    if (!checked.success) {
      throw new AIError('AI_OUTPUT_INVALID', `Model output failed schema validation: ${checked.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, false, usage);
    }
    return { output: checked.data, usage, model: response.model ?? this.cfg.model, promptVersion, latencyMs: Date.now() - started };
  }
}

/** Maps SDK errors to retryable / permanent without ever including request headers or the key. */
export function toAIError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.APIConnectionError) return new AIError('PROVIDER_RETRYABLE', `Claude API connection failed: ${err.message}`, true);
  if (err instanceof Anthropic.RateLimitError) return new AIError('PROVIDER_RETRYABLE', 'Claude API rate limit reached', true);
  if (err instanceof Anthropic.InternalServerError) return new AIError('PROVIDER_RETRYABLE', `Claude API unavailable (${err.status})`, true);
  if (err instanceof Anthropic.AuthenticationError) return new AIError('PROVIDER_ERROR', 'Claude API rejected the credentials', false);
  if (err instanceof Anthropic.PermissionDeniedError) return new AIError('PROVIDER_ERROR', 'Claude API permission denied', false);
  if (err instanceof Anthropic.BadRequestError) return new AIError('PROVIDER_ERROR', `Claude API rejected the request: ${err.message}`, false);
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === 408 || err.status === 409 || (err.status ?? 0) >= 500;
    return new AIError(retryable ? 'PROVIDER_RETRYABLE' : 'PROVIDER_ERROR', `Claude API error (${err.status ?? 'unknown'})`, retryable);
  }
  // The SDK's own parse failures (malformed JSON from the model) are invalid output; anything else is a bug.
  if (err instanceof SyntaxError || err instanceof Anthropic.AnthropicError) {
    return new AIError('AI_OUTPUT_INVALID', `Could not parse model output: ${err.message}`, false);
  }
  return new AIError('PROVIDER_ERROR', err instanceof Error ? err.message : String(err), false);
}
