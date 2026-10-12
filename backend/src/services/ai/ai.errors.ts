export interface AIUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type AIErrorCode =
  // output / content
  | 'AI_OUTPUT_INVALID'
  | 'AI_REFUSED'
  | 'AI_TRUNCATED'
  // transient (retried)
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RETRYABLE'
  // permanent
  | 'AI_AUTHENTICATION_FAILED'
  | 'AI_INSUFFICIENT_CREDITS'
  | 'AI_QUOTA_EXCEEDED'
  | 'AI_MODEL_NOT_FOUND'
  | 'AI_BAD_REQUEST'
  | 'PROVIDER_ERROR'
  | 'AI_NOT_CONFIGURED'
  | 'CONTEXT_UNAVAILABLE';

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
