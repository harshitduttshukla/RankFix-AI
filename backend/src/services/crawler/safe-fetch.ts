import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch, type Response } from 'undici';
import { isBlockedHostname, isBlockedIp } from './ip-policy.js';

export type FetchErrorCode =
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'DNS'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'REDIRECT_LIMIT'
  | 'REDIRECT_OUT_OF_SCOPE'
  | 'NETWORK';

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly details?: { location?: string },
  ) {
    super(message);
  }
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export interface NetworkPolicy {
  /** Only for tests against a local fixture server. Never enabled by configuration. */
  allowPrivate: boolean;
  /** null = any port (tests); default allows only 80/443. */
  allowedPorts: Set<string> | null;
  resolve: Resolver;
}

const systemResolve: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

export const DEFAULT_POLICY: NetworkPolicy = {
  allowPrivate: false,
  allowedPorts: new Set(['', '80', '443']),
  resolve: systemResolve,
};

let activePolicy: NetworkPolicy = DEFAULT_POLICY;
export const networkPolicy = () => activePolicy;
/** Test hook (mirrors setGscApiClient). */
export function setNetworkPolicy(policy: NetworkPolicy) {
  activePolicy = policy;
}

/** URL-level checks: scheme, credentials, port, hostname. Throws FetchError. */
export function assertFetchableUrl(raw: string, policy: NetworkPolicy = activePolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('INVALID_URL', `Invalid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('INVALID_URL', `Unsupported scheme ${url.protocol}`);
  if (url.username || url.password) throw new FetchError('INVALID_URL', 'URLs with credentials are not allowed');
  if (policy.allowedPorts && !policy.allowedPorts.has(url.port)) {
    throw new FetchError('SSRF_BLOCKED', `Port ${url.port} is not allowed`);
  }
  if (!policy.allowPrivate && isBlockedHostname(url.hostname)) {
    throw new FetchError('SSRF_BLOCKED', `Host ${url.hostname} is not allowed`);
  }
  return url;
}

/**
 * Resolves and validates every address. Used as the socket's DNS lookup, so the IP we check is the IP we
 * connect to (no TOCTOU window for DNS rebinding).
 */
export async function resolvePublic(hostname: string, policy: NetworkPolicy = activePolicy): Promise<LookupAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (!policy.allowPrivate && isBlockedIp(bare)) throw new FetchError('SSRF_BLOCKED', `Address ${bare} is not allowed`);
    return [{ address: bare, family: isIP(bare) }];
  }
  let addrs: LookupAddress[];
  try {
    addrs = await policy.resolve(bare);
  } catch {
    throw new FetchError('DNS', `Could not resolve ${bare}`);
  }
  if (!addrs.length) throw new FetchError('DNS', `No addresses for ${bare}`);
  if (!policy.allowPrivate) {
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad) throw new FetchError('SSRF_BLOCKED', `${bare} resolves to a private or reserved address`);
  }
  return addrs;
}

function agentFor(policy: NetworkPolicy, timeoutMs: number) {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: {
      timeout: timeoutMs,
      lookup: (hostname, options, callback) => {
        resolvePublic(hostname, policy).then(
          (addrs) => {
            if ((options as { all?: boolean }).all) callback(null, addrs);
            else callback(null, addrs[0]!.address, addrs[0]!.family);
          },
          (err: Error) => callback(err as NodeJS.ErrnoException, '', 0),
        );
      },
    },
  });
}

export interface SafeFetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  accept?: string;
  /** Redirect targets must satisfy this (e.g. same website). */
  inScope?: (url: string) => boolean;
  policy?: NetworkPolicy;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
  status: number;
  headers: Headers;
  contentType: string;
  body: Buffer;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** SSRF-safe GET with manual redirect handling, overall timeout and a hard byte cap. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const policy = opts.policy ?? activePolicy;
  const agent = agentFor(policy, opts.timeoutMs);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const redirects: string[] = [];
  let current = assertFetchableUrl(rawUrl, policy).toString();

  try {
    for (;;) {
      let res: Response;
      try {
        res = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          dispatcher: agent,
          signal,
          headers: {
            'user-agent': opts.userAgent,
            accept: opts.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-language': 'en;q=0.9,*;q=0.5',
          },
        });
      } catch (err) {
        throw classify(err, signal);
      }

      if (REDIRECT.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get('location');
        if (!location) return finalize(rawUrl, current, redirects, res, Buffer.alloc(0));
        const next = new URL(location, current).toString();
        if (redirects.length >= opts.maxRedirects) throw new FetchError('REDIRECT_LIMIT', `More than ${opts.maxRedirects} redirects`);
        assertFetchableUrl(next, policy);
        if (opts.inScope && !opts.inScope(next)) {
          throw new FetchError('REDIRECT_OUT_OF_SCOPE', `Redirects outside the website to ${next}`, { location: next });
        }
        redirects.push(current);
        current = next;
        continue;
      }

      const body = await readCapped(res, opts.maxBytes, signal);
      return finalize(rawUrl, current, redirects, res, body);
    }
  } finally {
    void agent.close();
  }
}

function finalize(requestedUrl: string, finalUrl: string, redirects: string[], res: Response, body: Buffer): SafeFetchResult {
  return {
    requestedUrl,
    finalUrl,
    redirects,
    status: res.status,
    headers: res.headers as unknown as Headers,
    contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
    body,
  };
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError('TOO_LARGE', `Response is ${declared} bytes (limit ${maxBytes})`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        await res.body.cancel().catch(() => {});
        throw new FetchError('TOO_LARGE', `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw classify(err, signal);
  }
  return Buffer.concat(chunks);
}

function classify(err: unknown, signal: AbortSignal): FetchError {
  if (err instanceof FetchError) return err;
  if (signal.aborted) return new FetchError('TIMEOUT', 'Request timed out');
  // undici wraps connect/lookup errors in TypeError('fetch failed', { cause })
  let cause: unknown = err;
  for (let i = 0; i < 5 && cause; i++) {
    if (cause instanceof FetchError) return cause;
    const code = (cause as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new FetchError('DNS', 'DNS lookup failed');
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new FetchError('TIMEOUT', 'Request timed out');
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return new FetchError('NETWORK', (err as Error)?.message ?? 'Network error');
}

/** Decodes a body using the HTTP charset, then <meta charset>, then UTF-8. */
export function decodeBody(body: Buffer, contentType: string): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const head = body.subarray(0, 2048).toString('latin1');
  const fromMeta =
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1];
  for (const label of [fromHeader, fromMeta, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      /* unknown label → try next */
    }
  }
  return body.toString('utf8');
}

export const isHtmlContentType = (ct: string) => /^(text\/html|application\/xhtml\+xml)\b/.test(ct) || ct === '';
