export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CSRF_INVALID'
  | 'INVALID_STATE_TRANSITION'
  | 'STALE_CONTENT_VERSION'
  | 'GSC_NOT_CONNECTED'
  | 'AI_OUTPUT_INVALID'
  | 'AI_REFUSED'
  | 'AI_NOT_CONFIGURED'
  | 'UPDATE_PROVIDER_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  STALE_CONTENT_VERSION: 409,
  GSC_NOT_CONNECTED: 409,
  AI_OUTPUT_INVALID: 502,
  AI_REFUSED: 422,
  AI_NOT_CONFIGURED: 503,
  UPDATE_PROVIDER_ERROR: 502,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (entity: string) => new AppError('NOT_FOUND', `${entity} not found`);
