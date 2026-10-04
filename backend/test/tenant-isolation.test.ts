import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/database.js';
import { decryptSecret } from '../src/utils/crypto.js';
import { clientWithProject, registeredClient, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const SECRET = 's'.repeat(40);

describe('projects & websites', () => {
  it('creates a project in the user organization and lists it', async () => {
    const a = await clientWithProject('alice');
    const list = await a.get('/api/projects').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: a.project.id, role: 'OWNER' });
    expect(await prisma.auditLog.count({ where: { action: 'project.created', projectId: a.project.id } })).toBe(1);
  });

  it('creates a website, normalizes the URL and encrypts the update secret', async () => {
    const a = await clientWithProject('alice');
    const res = await a
      .post(`/api/projects/${a.project.id}/websites`, {
        baseUrl: 'https://WWW.Example.com/some/path?x=1',
        blogPathPrefix: '/blog/',
        updateEndpointUrl: 'https://www.example.com/_gsc-optimizer/',
        updateSecret: SECRET,
      })
      .expect(201);

    expect(res.body).toMatchObject({ baseUrl: 'https://www.example.com', hostname: 'www.example.com', hasUpdateSecret: true });
    expect(res.body.updateEndpointUrl).toBe('https://www.example.com/_gsc-optimizer');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.updateSecretEnc).toBeUndefined();

    const row = await prisma.website.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.updateSecretEnc).not.toContain(SECRET);
    expect(decryptSecret(row.updateSecretEnc!)).toBe(SECRET);
    expect(row.organizationId).toBe(a.project.organizationId);
  });

  it.each([
    ['http://localhost', 'localhost'],
    ['http://127.0.0.1', 'IP literal'],
    ['http://10.0.0.5', 'private IP'],
    ['http://[::1]', 'IPv6 loopback'],
    ['ftp://example.com', 'non-http scheme'],
    ['https://example.com:8443', 'non-default port'],
    ['https://user:pw@example.com', 'credentials'],
    ['http://metadata.internal', 'internal TLD'],
  ])('rejects unsafe website URL %s (%s)', async (baseUrl) => {
    const a = await clientWithProject('alice');
    const res = await a.post(`/api/projects/${a.project.id}/websites`, { baseUrl }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an update endpoint on a different domain', async () => {
    const a = await clientWithProject('alice');
    await a
      .post(`/api/projects/${a.project.id}/websites`, {
        baseUrl: 'https://example.com',
        updateEndpointUrl: 'https://attacker.com/hook',
        updateSecret: SECRET,
      })
      .expect(400);
  });
});

describe('tenant isolation', () => {
  async function twoTenants() {
    const alice = await clientWithProject('alice');
    const bob = await clientWithProject('bob');
    const site = (
      await alice.post(`/api/projects/${alice.project.id}/websites`, { baseUrl: 'https://alice.example.com' }).expect(201)
    ).body;
    return { alice, bob, site };
  }

  it('does not list other tenants projects', async () => {
    const { bob } = await twoTenants();
    const list = await bob.get('/api/projects').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(bob.project.id);
  });

  it('returns 404 (not 403) for another tenant project and its websites', async () => {
    const { alice, bob } = await twoTenants();
    const r1 = await bob.get(`/api/projects/${alice.project.id}`).expect(404);
    expect(r1.body.error.code).toBe('NOT_FOUND');
    await bob.get(`/api/projects/${alice.project.id}/websites`).expect(404);
  });

  it('prevents creating a website in another tenant project', async () => {
    const { alice, bob } = await twoTenants();
    await bob.post(`/api/projects/${alice.project.id}/websites`, { baseUrl: 'https://evil.example.com' }).expect(404);
    expect(await prisma.website.count({ where: { projectId: alice.project.id } })).toBe(1);
  });

  it('returns 404 for another tenant website by id', async () => {
    const { alice, bob, site } = await twoTenants();
    await alice.get(`/api/websites/${site.id}`).expect(200);
    await bob.get(`/api/websites/${site.id}`).expect(404);
  });

  it('ignores a client-supplied organizationId the user does not belong to', async () => {
    const { alice, bob } = await twoTenants();
    const res = await bob.post('/api/projects', { name: 'hijack', organizationId: alice.project.organizationId }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await prisma.project.count({ where: { organizationId: alice.project.organizationId } })).toBe(1);
  });

  it('ignores organizationId/projectId smuggled in the website body', async () => {
    const { alice, bob } = await twoTenants();
    const res = await bob
      .post(`/api/projects/${bob.project.id}/websites`, {
        baseUrl: 'https://bob.example.com',
        organizationId: alice.project.organizationId,
        projectId: alice.project.id,
      })
      .expect(201);
    const row = await prisma.website.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.organizationId).toBe(bob.project.organizationId);
    expect(row.projectId).toBe(bob.project.id);
  });

  it('enforces roles within an organization', async () => {
    const { alice } = await twoTenants();
    const viewer = await registeredClient('viewer');
    await prisma.membership.create({
      data: { userId: viewer.user.id, organizationId: alice.project.organizationId, role: 'VIEWER' },
    });

    await viewer.get(`/api/projects/${alice.project.id}/websites`).expect(200);
    const res = await viewer.post(`/api/projects/${alice.project.id}/websites`, { baseUrl: 'https://v.example.com' }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    await viewer.post('/api/projects', { name: 'x', organizationId: alice.project.organizationId }).expect(403);
  });

  it('database rejects a website whose projectId/organizationId do not match', async () => {
    const { alice, bob } = await twoTenants();
    await expect(
      prisma.website.create({
        data: {
          organizationId: bob.project.organizationId, // mismatched with alice's project
          projectId: alice.project.id,
          baseUrl: 'https://x.example.com',
          hostname: 'x.example.com',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects malformed ids before touching the database', async () => {
    const { bob } = await twoTenants();
    await bob.get(`/api/projects/${encodeURIComponent("x' OR 1=1 --")}`).expect(400);
  });
});
