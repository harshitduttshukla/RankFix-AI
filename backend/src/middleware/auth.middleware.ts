import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export const ACCESS_COOKIE = 'access_token';
export const JWT_ISSUER = 'gsc-optimizer';
export const JWT_AUDIENCE = 'gsc-optimizer-api';

interface AccessClaims {
  sub: string;
  email: string;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token: unknown = req.cookies?.[ACCESS_COOKIE];
  if (typeof token !== 'string' || !token) return next(new AppError('UNAUTHENTICATED', 'Not signed in'));
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as AccessClaims;
    req.user = { id: claims.sub, email: claims.email };
    next();
  } catch {
    next(new AppError('UNAUTHENTICATED', 'Session expired'));
  }
};
