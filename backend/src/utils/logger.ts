import { pino, type DestinationStream, type LoggerOptions } from 'pino';

/**
 * Paths censored in every log line. pino-http serializes both request and response headers, so the response's
 * Set-Cookie (access and refresh tokens on register/login/refresh) must be redacted alongside the request Cookie.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.refreshToken',
  '*.updateSecret',
  '*.apiKey',
  '*.OPENROUTER_API_KEY',
  '*.GEMINI_API_KEY',
  '*.headers["x-goog-api-key"]',
  '*.headers["x-api-key"]',
  '*.headers.authorization',
  '*.headers.Authorization',
];

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: REDACT_PATHS,
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
};

/** A logger with the application's redaction rules, writing to `destination` (tests capture output this way). */
export function createLogger(destination: DestinationStream, level = 'info') {
  return pino({ ...options, level, transport: undefined }, destination);
}

export const logger = pino(options);
