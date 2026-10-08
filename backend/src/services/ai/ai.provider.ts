import { aiConfig, AINotConfiguredError } from './ai.config.js';
import { AIError, type AIUsage } from './ai.errors.js';
import type { AIContext } from './ai-context.builder.js';
import type { OpportunityAnalysis, RecommendationSet } from './ai.schemas.js';
import { AnthropicProvider } from './anthropic.provider.js';

/*
 * The only AI surface application services see. Implementations own transport, model config and
 * structured-output handling; they return schema-validated objects or throw an AIError.
 */

export interface AIResult<T> {
  output: T;
  usage: AIUsage;
  model: string;
  promptVersion: string;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  analyzeOpportunity(context: AIContext): Promise<AIResult<OpportunityAnalysis>>;
  generateRecommendation(context: AIContext, analysis: OpportunityAnalysis): Promise<AIResult<RecommendationSet>>;
}

let current: AIProvider | null = null;

/** Lazily builds the configured provider (Anthropic in V1). */
export function aiProvider(): AIProvider {
  if (current) return current;
  try {
    current = new AnthropicProvider(aiConfig());
  } catch (err) {
    if (err instanceof AINotConfiguredError) throw new AIError('AI_NOT_CONFIGURED', err.message, false);
    throw err;
  }
  return current;
}

/** Tests inject a fake; null resets to the configured provider. */
export function setAIProvider(p: AIProvider | null) {
  current = p;
}
