import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/database.js';
import request from 'supertest';
import { app, client, registeredClient, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const cookieNames = (res: { headers: Record<string, unknown> }) =>
  ((res.headers['set-cookie'] as string[] | undefined) ?? []).map((c) => c.split('=')[0]);

describe('auth', () => {
  it('registers a user with their own organization and sets HttpOnly cookies', async () => {
    const c = await client();
    const res = await c.post('/api/auth/register', { email: 'A@Example.com', password: 'correct horse battery' }).expect(201);

    expect(res.body.user.email).toBe('a@example.com');
    expect(res.body.user.passwordHash).toBeUndefined();
    const setCookies = res.headers['set-cookie'] as unknown as string[];
    expect(setCookies.find((c) => c.startsWith('access_token='))).toMatch(/HttpOnly/i);
    expect(setCookies.find((c) => c.startsWith('refresh_token='))).toMatch(/HttpOnly.*|Path=\/api\/auth/i);

    const me = await c.get('/api/auth/me').expect(200);
    expect(me.body.organizations).toHaveLength(1);
    expect(me.body.organizations[0].role).toBe('OWNER');

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'a@example.com' } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await prisma.auditLog.count({ where: { action: 'auth.registered' } })).toBe(1);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    const c = await client();
    await c.post('/api/auth/register', { email: 'x@example.com', password: 'short' }).expect(400);
    await c.post('/api/auth/register', { email: 'x@example.com', password: 'correct horse battery' }).expect(201);
    const dup = await c.post('/api/auth/register', { email: 'x@example.com', password: 'correct horse battery' }).expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('logs in with valid credentials and rejects invalid ones with the same error', async () => {
    const { email } = await registeredClient('login');
    const c = await client();
    const wrongPw = await c.post('/api/auth/login', { email, password: 'wrong password!!' }).expect(401);
    const noUser = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever123' }).expect(401);
    expect(wrongPw.body.error.message).toBe(noUser.body.error.message);

    await c.post('/api/auth/login', { email, password: 'correct horse battery' }).expect(200);
    await c.get('/api/auth/me').expect(200);
  });

  it('requires authentication for protected routes', async () => {
    const c = await client();
    const res = await c.get('/api/auth/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    await c.get('/api/projects').expect(401);
  });

  it('rejects tampered access tokens', async () => {
    const c = await client();
    await c.agent.get('/api/auth/me').set('Cookie', 'access_token=eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.').expect(401);
  });

  it('rejects state-changing requests without a matching CSRF token', async () => {
    const c = await registeredClient('csrf');
    await c.agent.post('/api/projects').send({ name: 'p' }).expect(403);
    const bad = await c.agent.post('/api/projects').set('x-csrf-token', 'wrong').send({ name: 'p' }).expect(403);
    expect(bad.body.error.code).toBe('CSRF_INVALID');
    await c.post('/api/projects', { name: 'p' }).expect(201);
  });

  it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
    const c = await client();
    const reg = await c.post('/api/auth/register', { email: 'r@example.com', password: 'correct horse battery' }).expect(201);
    const refreshCookie = (reg.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('refresh_token='))!;
    const firstRefresh = refreshCookie.split(';')[0]!;

    const r1 = await c.post('/api/auth/refresh').expect(200);
    expect(cookieNames(r1)).toContain('refresh_token');
    expect(await prisma.session.count({ where: { revokedAt: null, rotatedAt: null } })).toBe(1);

    // Replay the first (now rotated) token from another client: theft signal -> whole family revoked.
    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('x-csrf-token', c.csrf)
      .set('Cookie', `${firstRefresh}; csrf_token=${c.csrf}`)
      .expect(401);
    expect(replay.body.error.code).toBe('UNAUTHENTICATED');
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(0);

    // The legitimate client's newer token is now dead too.
    await c.post('/api/auth/refresh').expect(401);
  });

  it('logout revokes the session', async () => {
    const c = await registeredClient('logout');
    await c.post('/api/auth/logout').expect(204);
    await c.post('/api/auth/refresh').expect(401);
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(0);
  });
});
