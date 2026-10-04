import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ACCESS_COOKIE, JWT_AUDIENCE, JWT_ISSUER } from '../middleware/auth.middleware.js';
import { gscService } from '../services/gsc/gsc.service.js';

/** Soft session read for the OAuth callback (a top-level redirect from Google, so we redirect instead of 401). */
function sessionUserId(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  try {
    return (jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE }) as { sub: string }).sub;
  } catch {
    return undefined;
  }
}

export const gscController = {
  connect: (async (req, res) => {
    res.json(await gscService.connect(req.tenant!));
  }) satisfies RequestHandler,

  callback: (async (req, res) => {
    const result = await gscService.handleCallback(res.locals.query, sessionUserId(req.cookies?.[ACCESS_COOKIE]), req.ip);
    const target = new URL('/settings/gsc', env.FRONTEND_ORIGIN);
    if (result.ok) target.searchParams.set('status', 'connected');
    else target.searchParams.set('error', result.reason);
    res.redirect(303, target.toString());
  }) satisfies RequestHandler,

  status: (async (req, res) => {
    res.json(await gscService.status(req.tenant!));
  }) satisfies RequestHandler,

  properties: (async (req, res) => {
    res.json(await gscService.getProperties(req.tenant!));
  }) satisfies RequestHandler,

  selectProperty: (async (req, res) => {
    res.json(await gscService.selectProperty(req.tenant!, req.body));
  }) satisfies RequestHandler,

  sync: (async (req, res) => {
    res.status(202).json(await gscService.syncSearchAnalytics(req.tenant!, req.body));
  }) satisfies RequestHandler,

  performance: (async (req, res) => {
    res.json(await gscService.getPerformance(req.tenant!, res.locals.query));
  }) satisfies RequestHandler,

  disconnect: (async (req, res) => {
    await gscService.disconnect(req.tenant!);
    res.status(204).end();
  }) satisfies RequestHandler,
};
