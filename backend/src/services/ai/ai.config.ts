import { env } from '../../config/env.js';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AIProviderName = 'openrouter' | 'gemini';

export interface AIConfig {
  provider: AIProviderName;
  /** The selected provider's key (OPENROUTER_API_KEY or GEMINI_API_KEY). Never logged. */
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  /** OpenRouter only: base URL. */
  baseUrl: string;
  /** OpenRouter only: how structured output is requested; validation is identical in both modes. */
  outputMode: 'json_schema' | 'prompt';
  /** OpenRouter only: unified `reasoning.effort`; omitted from requests when unset. */
  reasoningEffort: ReasoningEffort | null;
}

export class AINotConfiguredError extends Error {}

type EnvLike = Pick<
  typeof env,
  | 'AI_PROVIDER'
  | 'OPENROUTER_API_KEY'
  | 'GEMINI_API_KEY'
  | 'OPENROUTER_BASE_URL'
  | 'AI_MODEL'
  | 'AI_MAX_TOKENS'
  | 'AI_TIMEOUT_MS'
  | 'AI_MAX_RETRIES'
  | 'AI_REASONING_EFFORT'
  | 'AI_OUTPUT_MODE'
>;

const KEY_VAR: Record<AIProviderName, 'OPENROUTER_API_KEY' | 'GEMINI_API_KEY'> = { openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY' };

/** Resolves AI settings for the selected provider; throws (without echoing values) when a required one is missing. */
export function aiConfig(source: EnvLike = env): AIConfig {
  const provider = source.AI_PROVIDER;
  const keyVar = KEY_VAR[provider];
  const missing = [!source[keyVar] && keyVar, !source.AI_MODEL && 'AI_MODEL'].filter(Boolean);
  if (missing.length) throw new AINotConfiguredError(`AI is not configured for provider "${provider}": set ${missing.join(' and ')}`);
  return {
    provider,
    apiKey: source[keyVar]!,
    model: source.AI_MODEL!,
    maxTokens: source.AI_MAX_TOKENS,
    timeoutMs: source.AI_TIMEOUT_MS,
    maxRetries: source.AI_MAX_RETRIES,
    baseUrl: source.OPENROUTER_BASE_URL,
    outputMode: source.AI_OUTPUT_MODE,
    reasoningEffort: source.AI_REASONING_EFFORT ?? null,
  };
}

export function isAiConfigured(source: Pick<EnvLike, 'AI_PROVIDER' | 'OPENROUTER_API_KEY' | 'GEMINI_API_KEY' | 'AI_MODEL'> = env) {
  return Boolean(source[KEY_VAR[source.AI_PROVIDER]] && source.AI_MODEL);
}
