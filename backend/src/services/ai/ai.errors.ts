export interface AIUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type AIErrorCode = 'AI_OUTPUT_INVALID' | 'AI_REFUSED' | 'AI_TRUNCATED' | 'PROVIDER_RETRYABLE' | 'PROVIDER_ERROR' | 'AI_NOT_CONFIGURED' | 'CONTEXT_UNAVAILABLE';

/** `retryable` decides whether the job is retried; invalid output and refusals never are. */
export class AIError extends Error {
  constructor(
    readonly code: AIErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly usage?: AIUsage,
  ) {
    super(message);
  }
}
