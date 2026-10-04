import { pino } from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.refreshToken', '*.updateSecret'],
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
