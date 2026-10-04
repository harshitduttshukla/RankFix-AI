import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import { randomToken } from '../../utils/crypto.js';

const AUDIENCE = 'gsc-oauth-state';
const TTL_SECONDS = 600;

interface StateClaims {
  pid: string;
  uid: string;
  nonce: string;
}

/** Signed, short-lived, single-use OAuth state bound to the user and project that started the flow. */
export async function createOAuthState(projectId: string, userId: string) {
  const nonce = randomToken(16);
  await redis().set(`oauth:gsc:${nonce}`, '1', 'EX', TTL_SECONDS);
  return jwt.sign({ pid: projectId, uid: userId, nonce } satisfies StateClaims, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    audience: AUDIENCE,
    expiresIn: TTL_SECONDS,
  });
}

/** Returns the claims if valid and not yet used; consumes the nonce. */
export async function consumeOAuthState(state: string): Promise<StateClaims | null> {
  let claims: StateClaims;
  try {
    claims = jwt.verify(state, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], audience: AUDIENCE }) as StateClaims;
  } catch {
    return null;
  }
  const used = await redis().getdel(`oauth:gsc:${claims.nonce}`);
  return used ? claims : null;
}
