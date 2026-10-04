import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env.js';
import { ACCESS_COOKIE } from '../middleware/auth.middleware.js';
import { CSRF_COOKIE } from '../middleware/csrf.middleware.js';
import { authService, type ClientMeta, type IssuedTokens } from '../services/auth/auth.service.js';
import { randomToken } from '../utils/crypto.js';

const REFRESH_COOKIE = 'refresh_token';

const base: CookieOptions = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' };

const meta = (req: Request): ClientMeta => ({ ip: req.ip, userAgent: req.get('user-agent') });

function setAuthCookies(res: Response, tokens: IssuedTokens) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base, path: '/api', maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000 });
  // Refresh token is only ever sent to the auth endpoints.
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...base, path: '/api/auth', expires: tokens.refreshExpiresAt });
}

function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/auth' });
}

export const authController = {
  /** Issues the double-submit CSRF token (readable by JS, so not HttpOnly). */
  csrf: ((req, res) => {
    const existing: unknown = req.cookies?.[CSRF_COOKIE];
    const token = typeof existing === 'string' && existing.length >= 32 ? existing : randomToken(32);
    res.cookie(CSRF_COOKIE, token, { httpOnly: false, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/' });
    res.json({ csrfToken: token });
  }) satisfies RequestHandler,

  register: (async (req, res) => {
    const { user, tokens } = await authService.register(req.body, meta(req));
    setAuthCookies(res, tokens);
    res.status(201).json({ user });
  }) satisfies RequestHandler,

  login: (async (req, res) => {
    const { user, tokens } = await authService.login(req.body, meta(req));
    setAuthCookies(res, tokens);
    res.json({ user });
  }) satisfies RequestHandler,

  refresh: (async (req, res) => {
    try {
      const tokens = await authService.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
      setAuthCookies(res, tokens);
      res.json({ ok: true });
    } catch (err) {
      clearAuthCookies(res);
      throw err;
    }
  }) satisfies RequestHandler,

  logout: (async (req, res) => {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    clearAuthCookies(res);
    res.status(204).end();
  }) satisfies RequestHandler,

  me: (async (req, res) => {
    res.json(await authService.me(req.user!.id));
  }) satisfies RequestHandler,
};
