import { pino } from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.refreshToken', '*.updateSecret', '*.apiKey', '*.OPENROUTER_API_KEY', '*.GEMINI_API_KEY', '*.headers["x-goog-api-key"]', '*.headers["x-api-key"]', '*.headers.authorization', '*.headers.Authorization'],
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
