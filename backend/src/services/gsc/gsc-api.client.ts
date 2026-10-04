import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
/** Minimum scopes: read-only Search Console + identity (to show which Google account is connected). */
export const OAUTH_SCOPES = ['openid', 'email', GSC_SCOPE];

const API = 'https://www.googleapis.com/webmasters/v3';

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsQuery {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  dimensions: ('date' | 'page' | 'query')[];
  rowLimit: number;
  startRow: number;
}

export class GoogleAuthRevokedError extends Error {}

export class GscApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thin boundary around Google. Swapped for a fake in tests via setGscApiClient(). */
export interface GscApiClient {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<{ refreshToken: string | null; scope: string; email: string | null }>;
  listSites(refreshToken: string): Promise<GscSite[]>;
  querySearchAnalytics(refreshToken: string, siteUrl: string, body: SearchAnalyticsQuery): Promise<SearchAnalyticsRow[]>;
  revoke(refreshToken: string): Promise<void>;
}

const oauth = () => new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);

async function accessToken(refreshToken: string): Promise<string> {
  const client = oauth();
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new GoogleAuthRevokedError('Google returned no access token');
    return token;
  } catch (err) {
    const data = (err as { response?: { data?: { error?: string } } }).response?.data;
    if (data?.error === 'invalid_grant' || err instanceof GoogleAuthRevokedError) {
      throw new GoogleAuthRevokedError('Google access was revoked or expired. Reconnect Search Console.');
    }
    throw err;
  }
}

async function call<T>(refreshToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken(refreshToken)}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GscApiError(res.status, body.error?.message ?? `Search Console API error ${res.status}`);
  }
  return (await res.json()) as T;
}

export const googleGscApiClient: GscApiClient = {
  authUrl(state) {
    return oauth().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // guarantees a refresh token on reconnect
      include_granted_scopes: false,
      scope: OAUTH_SCOPES,
      state,
    });
  },

  async exchangeCode(code) {
    const client = oauth();
    const { tokens } = await client.getToken(code);
    let email: string | null = null;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
      email = ticket.getPayload()?.email ?? null;
    }
    return { refreshToken: tokens.refresh_token ?? null, scope: tokens.scope ?? '', email };
  },

  async listSites(refreshToken) {
    const body = await call<{ siteEntry?: GscSite[] }>(refreshToken, '/sites');
    return body.siteEntry ?? [];
  },

  async querySearchAnalytics(refreshToken, siteUrl, query) {
    const body = await call<{ rows?: SearchAnalyticsRow[] }>(
      refreshToken,
      `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: 'POST', body: JSON.stringify({ ...query, dataState: 'final' }) },
    );
    return body.rows ?? [];
  },

  async revoke(refreshToken) {
    await oauth().revokeToken(refreshToken);
  },
};

let active: GscApiClient = googleGscApiClient;
export const gscApi = () => active;
export function setGscApiClient(client: GscApiClient) {
  active = client;
}
