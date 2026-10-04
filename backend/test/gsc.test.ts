import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueEvents } from 'bullmq';
import { prisma } from '../src/config/database.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { closeGscQueue, GSC_SYNC_QUEUE, gscQueue } from '../src/queues/gsc.queue.js';
import { setGscApiClient } from '../src/services/gsc/gsc-api.client.js';
import { markGscSyncFailed, runGscSync, SyncAbortedError } from '../src/services/gsc/gsc-sync.service.js';
import { decryptSecret } from '../src/utils/crypto.js';
import { startGscWorker } from '../src/workers/gsc.worker.js';
import { FakeGsc, sampleRows } from './fake-gsc.js';
import { clientWithProject, resetDb, stateFromAuthUrl } from './helpers.js';

let fake: FakeGsc;

beforeEach(async () => {
  await resetDb();
  await redis().flushdb();
  fake = new FakeGsc();
  setGscApiClient(fake);
});

afterAll(async () => {
  await closeGscQueue();
  await closeRedis();
  await prisma.$disconnect();
});

type C = Awaited<ReturnType<typeof clientWithProject>>;

async function connect(c: C) {
  const { authUrl } = (await c.post(`/api/projects/${c.project.id}/gsc/connect`).expect(200)).body;
  const state = await stateFromAuthUrl(authUrl);
  return c.get(`/api/gsc/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`).expect(303);
}

async function connectedWithProperty(name = 'alice') {
  const c = await clientWithProject(name);
  const site = (await c.post(`/api/projects/${c.project.id}/websites`, { baseUrl: `https://${name}.example.com` }).expect(201)).body;
  await connect(c);
  const property = (
    await c.post(`/api/projects/${c.project.id}/gsc/select-property`, { websiteId: site.id, siteUrl: `sc-domain:${name}.example.com` }).expect(200)
  ).body;
  return { ...c, site, property };
}

const syncData = (c: Awaited<ReturnType<typeof connectedWithProperty>>, days?: number) => ({
  organizationId: c.project.organizationId,
  projectId: c.project.id,
  propertyId: c.property.id,
  days,
});

describe('GSC OAuth', () => {
  it('requests only read-only scopes and stores an encrypted refresh token', async () => {
    const c = await clientWithProject('alice');
    const res = await connect(c);
    expect(res.headers.location).toBe('http://localhost:3100/settings/gsc?status=connected');

    const conn = await prisma.gSCConnection.findFirstOrThrow({ where: { projectId: c.project.id } });
    expect(conn.refreshTokenEnc).not.toContain('refresh-token-from-google');
    expect(decryptSecret(conn.refreshTokenEnc)).toBe('refresh-token-from-google');
    expect(conn.scope).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    expect(conn.googleEmail).toBe('owner@alice.example.com');
    expect(await prisma.auditLog.count({ where: { action: 'gsc.connected' } })).toBe(1);

    const status = (await c.get(`/api/projects/${c.project.id}/gsc`).expect(200)).body;
    expect(status).toMatchObject({ connected: true, googleEmail: 'owner@alice.example.com' });
    expect(JSON.stringify(status)).not.toContain('refresh');
  });

  it('rejects a reused state (single use)', async () => {
    const c = await clientWithProject('alice');
    const { authUrl } = (await c.post(`/api/projects/${c.project.id}/gsc/connect`).expect(200)).body;
    const state = encodeURIComponent(await stateFromAuthUrl(authUrl));
    await c.get(`/api/gsc/oauth/callback?code=good-code&state=${state}`).expect(303);
    const again = await c.get(`/api/gsc/oauth/callback?code=good-code&state=${state}`).expect(303);
    expect(again.headers.location).toContain('error=invalid_state');
  });

  it('rejects a tampered state', async () => {
    const c = await clientWithProject('alice');
    const res = await c.get('/api/gsc/oauth/callback?code=good-code&state=eyJhbGciOiJIUzI1NiJ9.e30.x').expect(303);
    expect(res.headers.location).toContain('error=invalid_state');
    expect(await prisma.gSCConnection.count()).toBe(0);
  });

  it('rejects completing another user\'s flow (state bound to user)', async () => {
    const alice = await clientWithProject('alice');
    const bob = await clientWithProject('bob');
    const { authUrl } = (await alice.post(`/api/projects/${alice.project.id}/gsc/connect`).expect(200)).body;
    const res = await bob.get(`/api/gsc/oauth/callback?code=good-code&state=${encodeURIComponent(await stateFromAuthUrl(authUrl))}`).expect(303);
    expect(res.headers.location).toContain('error=session_mismatch');
    expect(await prisma.gSCConnection.count()).toBe(0);
  });

  it('rejects grants without the Search Console scope or refresh token', async () => {
    const c = await clientWithProject('alice');
    fake.exchange = { ...fake.exchange, scope: 'openid email' };
    expect((await connect(c)).headers.location).toContain('error=scope_missing');
    fake.exchange = { ...new FakeGsc().exchange, refreshToken: null };
    expect((await connect(c)).headers.location).toContain('error=no_refresh_token');
    expect(await prisma.gSCConnection.count()).toBe(0);
  });

  it('reports a user-denied consent', async () => {
    const c = await clientWithProject('alice');
    const res = await c.get('/api/gsc/oauth/callback?error=access_denied').expect(303);
    expect(res.headers.location).toContain('error=access_denied');
  });

  it('only admins can start the connect flow', async () => {
    const c = await clientWithProject('alice');
    const editor = await clientWithProject('ed');
    await prisma.membership.create({ data: { userId: editor.user.id, organizationId: c.project.organizationId, role: 'EDITOR' } });
    await editor.post(`/api/projects/${c.project.id}/gsc/connect`).expect(403);
  });
});

describe('GSC properties', () => {
  it('lists verified properties with matching websites', async () => {
    const c = await clientWithProject('alice');
    const site = (await c.post(`/api/projects/${c.project.id}/websites`, { baseUrl: 'https://alice.example.com' }).expect(201)).body;
    await connect(c);
    const { properties } = (await c.get(`/api/projects/${c.project.id}/gsc/properties`).expect(200)).body;
    expect(properties.map((p: { siteUrl: string }) => p.siteUrl)).toEqual(['sc-domain:alice.example.com', 'https://other.example.org/']);
    expect(properties[0].matchingWebsiteIds).toEqual([site.id]);
  });

  it('requires a connection', async () => {
    const c = await clientWithProject('alice');
    const res = await c.get(`/api/projects/${c.project.id}/gsc/properties`).expect(409);
    expect(res.body.error.code).toBe('GSC_NOT_CONNECTED');
  });

  it('maps a property to a website and records an audit event', async () => {
    const c = await connectedWithProperty();
    expect(c.property).toMatchObject({ siteUrl: 'sc-domain:alice.example.com', websiteId: c.site.id, syncStatus: 'IDLE' });
    expect(await prisma.auditLog.count({ where: { action: 'gsc.property_selected' } })).toBe(1);
  });

  it('rejects properties the Google account cannot access, unverified ones, or other domains', async () => {
    const c = await clientWithProject('alice');
    const site = (await c.post(`/api/projects/${c.project.id}/websites`, { baseUrl: 'https://alice.example.com' }).expect(201)).body;
    await connect(c);
    const url = `/api/projects/${c.project.id}/gsc/select-property`;
    await c.post(url, { websiteId: site.id, siteUrl: 'sc-domain:not-mine.com' }).expect(403);
    await c.post(url, { websiteId: site.id, siteUrl: 'https://unverified.example.com/' }).expect(403);
    await c.post(url, { websiteId: site.id, siteUrl: 'https://other.example.org/' }).expect(400);
  });

  it('cannot map a property onto another tenant\'s website', async () => {
    const alice = await clientWithProject('alice');
    const aliceSite = (await alice.post(`/api/projects/${alice.project.id}/websites`, { baseUrl: 'https://alice.example.com' }).expect(201)).body;
    const bob = await clientWithProject('bob');
    await connect(bob);
    await bob
      .post(`/api/projects/${bob.project.id}/gsc/select-property`, { websiteId: aliceSite.id, siteUrl: 'sc-domain:alice.example.com' })
      .expect(404);
  });
});

describe('GSC sync', () => {
  it('stores page totals and query rows, merging URL variants', async () => {
    const c = await connectedWithProperty();
    fake.rowsFor = sampleRows;
    const result = await runGscSync(syncData(c, 2));

    expect(result.rowsStored).toBe(2 * (2 + 3)); // per day: 2 pages + 3 page-query rows
    const totals = await prisma.gSCSearchAnalytics.findMany({ where: { query: '', page: 'https://alice.example.com/blog/post-a' } });
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ clicks: 12, impressions: 1200, organizationId: c.project.organizationId, projectId: c.project.id });

    // Each day requests both page-level and page+query dimensions from Google.
    expect(fake.queries.map((q) => q.body.dimensions.join(','))).toEqual(['page', 'page,query', 'page', 'page,query']);

    const prop = await prisma.gSCProperty.findUniqueOrThrow({ where: { id: c.property.id } });
    expect(prop.syncStatus).toBe('IDLE');
    expect(prop.lastSyncedDate).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'gsc.sync_completed' } })).toBe(1);
  });

  it('is idempotent when the same days are re-synced', async () => {
    const c = await connectedWithProperty();
    fake.rowsFor = sampleRows;
    await runGscSync(syncData(c, 3));
    const first = await prisma.gSCSearchAnalytics.count();
    await runGscSync(syncData(c, 3));
    expect(await prisma.gSCSearchAnalytics.count()).toBe(first);
  });

  it('paginates large result sets', async () => {
    const c = await connectedWithProperty();
    fake.rowsFor = (q) =>
      q.dimensions.length === 1
        ? Array.from({ length: 25_001 }, (_, i) => ({ keys: [`https://alice.example.com/p/${i}`], clicks: 0, impressions: 1, ctr: 0, position: 10 }))
        : [];
    await runGscSync(syncData(c, 1));
    expect(fake.queries.filter((q) => q.body.dimensions.length === 1).map((q) => q.body.startRow)).toEqual([0, 25_000]);
    expect(await prisma.gSCSearchAnalytics.count()).toBe(25_001);
  });

  it('serves page performance with weighted position and top queries', async () => {
    const c = await connectedWithProperty();
    fake.rowsFor = sampleRows;
    await runGscSync(syncData(c, 2));

    const page = (await c.get(`/api/projects/${c.project.id}/gsc/performance?pageUrl=${encodeURIComponent('https://alice.example.com/blog/post-a/')}`).expect(200)).body;
    expect(page.totals).toMatchObject({ clicks: 24, impressions: 2400, ctr: 0.01, position: 7 });
    expect(page.daily).toHaveLength(2);
    expect(page.queries.map((q: { query: string }) => q.query)).toEqual(['seo guide', 'seo tips']);

    const site = (await c.get(`/api/projects/${c.project.id}/gsc/performance`).expect(200)).body;
    expect(site.pages[0].page).toBe('https://alice.example.com/blog/post-a');
    expect(site.totals.clicks).toBe(34);
  });

  it('marks a property FAILED with an audit event when sync fails for good', async () => {
    const c = await connectedWithProperty();
    fake.queryError = new Error('Search Console API error 500');
    await expect(runGscSync(syncData(c, 1))).rejects.toThrow('500');
    await markGscSyncFailed(syncData(c, 1), 'Search Console API error 500');
    const prop = await prisma.gSCProperty.findUniqueOrThrow({ where: { id: c.property.id } });
    expect(prop).toMatchObject({ syncStatus: 'FAILED', syncError: 'Search Console API error 500' });
    expect(await prisma.auditLog.count({ where: { action: 'gsc.sync_failed' } })).toBe(1);
    expect(await prisma.gSCSearchAnalytics.count()).toBe(0);
  });

  it('aborts without retry when Google access is revoked', async () => {
    const c = await connectedWithProperty();
    const { GoogleAuthRevokedError } = await import('../src/services/gsc/gsc-api.client.js');
    fake.queryError = new GoogleAuthRevokedError('revoked');
    await expect(runGscSync(syncData(c, 1))).rejects.toBeInstanceOf(SyncAbortedError);
    const conn = await prisma.gSCConnection.findFirstOrThrow();
    expect(conn.revokedAt).not.toBeNull();
    const status = (await c.get(`/api/projects/${c.project.id}/gsc`).expect(200)).body;
    expect(status).toMatchObject({ connected: false, revoked: true });
  });

  it('enqueues a background job and the worker completes it', async () => {
    const c = await connectedWithProperty();
    fake.rowsFor = sampleRows;
    const worker = startGscWorker();
    const events = new QueueEvents(GSC_SYNC_QUEUE, { connection: redis().duplicate() });
    await events.waitUntilReady();
    try {
      const res = await c.post(`/api/projects/${c.project.id}/gsc/sync`, { days: 2 }).expect(202);
      expect(res.body.jobs).toHaveLength(1);
      const job = await gscQueue().getJob(res.body.jobs[0].jobId);
      await job!.waitUntilFinished(events, 15_000);
      expect(await prisma.gSCSearchAnalytics.count()).toBe(10);
      const prop = await prisma.gSCProperty.findUniqueOrThrow({ where: { id: c.property.id } });
      expect(prop.syncStatus).toBe('IDLE');
    } finally {
      await worker.close();
      await events.close();
    }
  });

  it('collapses duplicate sync requests for the same property', async () => {
    const c = await connectedWithProperty();
    const r1 = await c.post(`/api/projects/${c.project.id}/gsc/sync`).expect(202);
    const r2 = await c.post(`/api/projects/${c.project.id}/gsc/sync`).expect(202);
    expect(r2.body.jobs[0].jobId).toBe(r1.body.jobs[0].jobId);
    expect(await gscQueue().getWaitingCount()).toBe(1);
  });

  it('rejects sync without a connection or by a viewer', async () => {
    const c = await clientWithProject('alice');
    expect((await c.post(`/api/projects/${c.project.id}/gsc/sync`).expect(409)).body.error.code).toBe('GSC_NOT_CONNECTED');
    const viewer = await clientWithProject('vic');
    await prisma.membership.create({ data: { userId: viewer.user.id, organizationId: c.project.organizationId, role: 'VIEWER' } });
    await viewer.post(`/api/projects/${c.project.id}/gsc/sync`).expect(403);
  });
});

describe('GSC tenant isolation & disconnect', () => {
  it('hides another tenant\'s GSC status and performance', async () => {
    const alice = await connectedWithProperty('alice');
    fake.rowsFor = sampleRows;
    await runGscSync(syncData(alice, 1));
    const bob = await clientWithProject('bob');
    await bob.get(`/api/projects/${alice.project.id}/gsc`).expect(404);
    await bob.get(`/api/projects/${alice.project.id}/gsc/performance`).expect(404);
    await bob.post(`/api/projects/${alice.project.id}/gsc/sync`).expect(404);
    const own = (await bob.get(`/api/projects/${bob.project.id}/gsc/performance`).expect(200)).body;
    expect(own.totals.impressions).toBe(0);
  });

  it('disconnect revokes at Google and removes connection, properties and data', async () => {
    const c = await connectedWithProperty();
    fake.rowsFor = sampleRows;
    await runGscSync(syncData(c, 1));
    await c.delete(`/api/projects/${c.project.id}/gsc`).expect(204);
    expect(fake.revoked).toEqual(['refresh-token-from-google']);
    expect(await prisma.gSCConnection.count()).toBe(0);
    expect(await prisma.gSCProperty.count()).toBe(0);
    expect(await prisma.gSCSearchAnalytics.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'gsc.disconnected' } })).toBe(1);
  });
});
