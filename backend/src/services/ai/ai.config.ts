import { env } from '../../config/env.js';

export interface AIConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  refusalFallback: boolean;
}

export class AINotConfiguredError extends Error {}

type EnvLike = Pick<typeof env, 'ANTHROPIC_API_KEY' | 'AI_MODEL' | 'AI_MAX_TOKENS' | 'AI_TIMEOUT_MS' | 'AI_MAX_RETRIES' | 'AI_EFFORT' | 'AI_REFUSAL_FALLBACK'>;

/** Resolves AI settings; throws (without echoing values) when a required one is missing. */
export function aiConfig(source: EnvLike = env): AIConfig {
  const missing = [!source.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY', !source.AI_MODEL && 'AI_MODEL'].filter(Boolean);
  if (missing.length) throw new AINotConfiguredError(`AI is not configured: set ${missing.join(' and ')}`);
  return {
    apiKey: source.ANTHROPIC_API_KEY!,
    model: source.AI_MODEL!,
    maxTokens: source.AI_MAX_TOKENS,
    timeoutMs: source.AI_TIMEOUT_MS,
    maxRetries: source.AI_MAX_RETRIES,
    effort: source.AI_EFFORT,
    refusalFallback: source.AI_REFUSAL_FALLBACK,
  };
}

export function isAiConfigured(source: EnvLike = env) {
  return Boolean(source.ANTHROPIC_API_KEY && source.AI_MODEL);
}
