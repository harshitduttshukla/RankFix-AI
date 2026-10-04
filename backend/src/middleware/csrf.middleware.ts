import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Double-submit cookie check for every state-changing request. */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookie: unknown = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);
  if (typeof cookie !== 'string' || !cookie || !header) {
    return next(new AppError('CSRF_INVALID', 'Missing CSRF token'));
  }
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new AppError('CSRF_INVALID', 'Invalid CSRF token'));
  }
  next();
};
