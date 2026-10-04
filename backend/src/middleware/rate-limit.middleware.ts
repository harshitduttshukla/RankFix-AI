import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/errors.js';

const handler: Parameters<typeof rateLimit>[0] extends infer O ? O extends { handler?: infer H } ? H : never : never = (
  _req,
  _res,
  next,
) => next(new AppError('RATE_LIMITED', 'Too many requests, slow down'));

export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
});

/** Tight limit on credential endpoints to slow brute force. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
});
