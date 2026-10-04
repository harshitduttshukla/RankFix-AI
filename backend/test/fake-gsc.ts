import type { GscApiClient, GscSite, SearchAnalyticsQuery, SearchAnalyticsRow } from '../src/services/gsc/gsc-api.client.js';
import { GSC_SCOPE } from '../src/services/gsc/gsc-api.client.js';

/** In-memory stand-in for Google. Each test configures what it needs. */
export class FakeGsc implements GscApiClient {
  sites: GscSite[] = [
    { siteUrl: 'sc-domain:alice.example.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://other.example.org/', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://unverified.example.com/', permissionLevel: 'siteUnverifiedUser' },
  ];
  exchange: { refreshToken: string | null; scope: string; email: string | null } = {
    refreshToken: 'refresh-token-from-google',
    scope: `openid ${GSC_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    email: 'owner@alice.example.com',
  };
  rowsFor: (q: SearchAnalyticsQuery, siteUrl: string) => SearchAnalyticsRow[] = () => [];
  queryError: Error | null = null;
  queries: { siteUrl: string; body: SearchAnalyticsQuery }[] = [];
  revoked: string[] = [];

  authUrl(state: string) {
    return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`;
  }
  async exchangeCode(code: string) {
    if (code === 'bad-code') throw new Error('invalid_grant');
    return this.exchange;
  }
  async listSites() {
    return this.sites;
  }
  async querySearchAnalytics(_rt: string, siteUrl: string, body: SearchAnalyticsQuery) {
    this.queries.push({ siteUrl, body });
    if (this.queryError) throw this.queryError;
    return this.rowsFor(body, siteUrl).slice(body.startRow, body.startRow + body.rowLimit);
  }
  async revoke(rt: string) {
    this.revoked.push(rt);
  }
}

/** Two pages, two queries; trailing-slash + utm variants of page A must merge into one URL. */
export function sampleRows(q: SearchAnalyticsQuery): SearchAnalyticsRow[] {
  const A = 'https://alice.example.com/blog/post-a';
  if (q.dimensions.length === 1) {
    return [
      { keys: [`${A}/`], clicks: 10, impressions: 1000, ctr: 0.01, position: 8 },
      { keys: [`${A}?utm_source=x`], clicks: 2, impressions: 200, ctr: 0.01, position: 2 },
      { keys: ['https://alice.example.com/blog/post-b'], clicks: 5, impressions: 100, ctr: 0.05, position: 3 },
    ];
  }
  return [
    { keys: [A, 'seo guide'], clicks: 6, impressions: 600, ctr: 0.01, position: 7 },
    { keys: [`${A}/`, 'seo tips'], clicks: 4, impressions: 400, ctr: 0.01, position: 9 },
    { keys: ['https://alice.example.com/blog/post-b', 'blog b'], clicks: 5, impressions: 100, ctr: 0.05, position: 3 },
  ];
}
