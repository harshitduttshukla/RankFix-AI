import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { TrustProxy } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';

/** The real HTTP logger (pino-http + application redaction), writing into memory. */
function loggedApp() {
  const lines: string[] = [];
  const app = createApp({ logger: createLogger({ write: (msg: string) => void lines.push(msg) }), httpLogging: true });
  return { app, lines };
}

/** Cookie values (tokens) from a response's Set-Cookie header. */
function cookieValues(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((c) => c.split(';')[0]!.split('=').slice(1).join('=')).filter((v) => v.length > 0);
}

describe('SEC-01: authentication cookies never reach the logs', () => {
  it('redacts Set-Cookie on register, login and refresh', async () => {
    const { app, lines } = loggedApp();
    const agent = request.agent(app);
    const csrf: string = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken;
    const email = `logcheck-${Date.now()}@example.com`;
    const password = 'correct horse battery';

    const responses = [
      await agent.post('/api/auth/register').set('x-csrf-token', csrf).send({ email, password }).expect(201),
      await agent.post('/api/auth/login').set('x-csrf-token', csrf).send({ email, password }).expect(200),
      await agent.post('/api/auth/refresh').set('x-csrf-token', csrf).send({}).expect(200),
    ];

    const tokens = responses.flatMap(cookieValues);
    // access + refresh cookie on each of the three responses
    expect(tokens.length).toBeGreaterThanOrEqual(6);

    const logged = lines.join('\n');
    const authLines = lines.map((l) => JSON.parse(l)).filter((l) => /\/api\/auth\/(register|login|refresh)/.test(l.req?.url ?? ''));
    expect(authLines).toHaveLength(3);
    for (const line of authLines) expect(line.res.headers['set-cookie']).toBe('[Redacted]');
    for (const token of tokens) expect(logged).not.toContain(token);
    expect(logged).not.toContain(password);
  });
});

describe('SEC-03: proxy trust', () => {
  it('parses TRUST_PROXY safely', () => {
    expect(TrustProxy.parse(undefined)).toBe('loopback');
    expect(TrustProxy.parse('')).toBe('loopback');
    expect(TrustProxy.parse('false')).toBe(false);
    expect(TrustProxy.parse('0')).toBe(false);
    expect(TrustProxy.parse('2')).toBe(2);
    expect(TrustProxy.parse('10.0.0.0/8, loopback')).toBe('10.0.0.0/8,loopback');
    expect(() => TrustProxy.parse('true')).toThrow(/trusts any client/);
    expect(() => TrustProxy.parse('my-proxy.internal')).toThrow();
    expect(() => TrustProxy.parse('10.0.0.0/8/1')).toThrow();
  });

  it('defaults to trusting only a loopback proxy, so a remote client cannot pick its own IP', () => {
    const trusted = createApp().get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trusted('127.0.0.1', 0)).toBe(true);
    expect(trusted('::1', 0)).toBe(true);
    expect(trusted('203.0.113.7', 0)).toBe(false);
  });

  it('ignores X-Forwarded-For entirely when disabled', async () => {
    const app = createApp({ trustProxy: false });
    const trusted = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trusted('127.0.0.1', 0)).toBe(false);
  });

  // req.ip is observed through the real global rate limiter: requests from the same IP share one counter.
  const remaining = (res: request.Response) => Number(/r=(\d+)/.exec(String(res.headers['ratelimit']))?.[1]);
  const hit = (app: ReturnType<typeof createApp>, xff: string) => request(app).get('/api/auth/csrf').set('x-forwarded-for', xff).expect(200);

  it('behind the trusted proxy, keys rate limits by the address the proxy appended, not a forged one', async () => {
    // Supertest connects over loopback, like the local reverse proxy (Next.js rewrite) does.
    const app = createApp();
    const a = await hit(app, '198.51.100.1, 203.0.113.21');
    const b = await hit(app, '198.51.100.2, 203.0.113.21'); // client forged a different leading entry
    const c = await hit(app, '203.0.113.22');
    expect(remaining(b)).toBe(remaining(a) - 1);
    expect(remaining(c)).toBe(remaining(a)); // a different real client gets its own fresh bucket
  });

  it('with proxy trust disabled, X-Forwarded-For cannot split a client into many rate-limit buckets', async () => {
    const app = createApp({ trustProxy: false });
    const a = await hit(app, '203.0.113.31');
    const b = await hit(app, '203.0.113.32');
    expect(remaining(b)).toBe(remaining(a) - 1);
  });
});
