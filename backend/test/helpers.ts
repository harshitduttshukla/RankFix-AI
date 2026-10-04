import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/database.js';

export const app = createApp();

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
}

/** A cookie-persisting client that performs the CSRF handshake like the browser app does. */
export async function client() {
  const agent = request.agent(app);
  const res = await agent.get('/api/auth/csrf').expect(200);
  const csrf: string = res.body.csrfToken;
  const send = (method: 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) =>
    agent[method](url).set('x-csrf-token', csrf).send(body ?? {});
  return {
    agent,
    csrf,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => send('post', url, body),
    patch: (url: string, body?: object) => send('patch', url, body),
    delete: (url: string) => send('delete', url),
  };
}

let seq = 0;
export async function registeredClient(name = 'user') {
  const c = await client();
  const email = `${name}${++seq}@example.com`;
  const res = await c.post('/api/auth/register', { email, password: 'correct horse battery', name }).expect(201);
  return { ...c, user: res.body.user as { id: string; email: string }, email };
}

export async function clientWithProject(name = 'user') {
  const c = await registeredClient(name);
  const project = (await c.post('/api/projects', { name: `${name} project` }).expect(201)).body;
  return { ...c, project: project as { id: string; organizationId: string } };
}
