import { aiConfig, AINotConfiguredError, type AIConfig } from './ai.config.js';
import { AIError, type AIUsage } from './ai.errors.js';
import type { AIContext } from './ai-context.builder.js';
import type { DraftOutput, OpportunityAnalysis, Recommendation, RecommendationSet } from './ai.schemas.js';
import { GeminiProvider } from './gemini.provider.js';
import { OpenRouterProvider } from './openrouter.provider.js';

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
  /** A fresh draft for one recommendation (reviewer-requested). previousDrafts are values the model must not repeat. */
  generateDraft(context: AIContext, recommendation: Recommendation, previousDrafts: string[]): Promise<AIResult<DraftOutput>>;
}

let current: AIProvider | null = null;

/** The single place that maps AI_PROVIDER to an implementation. */
export function createAIProvider(cfg: AIConfig): AIProvider {
  switch (cfg.provider) {
    case 'gemini':
      return new GeminiProvider(cfg);
    case 'openrouter':
      return new OpenRouterProvider(cfg);
  }
}

/** Lazily builds the configured provider. */
export function aiProvider(): AIProvider {
  if (current) return current;
  try {
    current = createAIProvider(aiConfig());
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
