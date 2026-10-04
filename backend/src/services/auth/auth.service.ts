import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../middleware/auth.middleware.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { sessionRepository } from '../../repositories/session.repository.js';
import { userRepository } from '../../repositories/user.repository.js';
import type { LoginInput, RegisterInput } from '../../schemas/auth.schema.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const ARGON_OPTS = { type: argon2.argon2id } as const;
// Verified against when the email is unknown, so login timing doesn't reveal which emails exist.
const DUMMY_HASH_PROMISE = argon2.hash('dummy-password-for-timing', ARGON_OPTS);

function signAccessToken(user: { id: string; email: string }) {
  return jwt.sign({ email: user.email }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

async function issueTokens(user: { id: string; email: string }, meta: ClientMeta, familyId = randomToken(16)) {
  const refreshToken = randomToken(32);
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await sessionRepository.create({
    userId: user.id,
    familyId,
    tokenHash: sha256(refreshToken),
    expiresAt: refreshExpiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 500),
  });
  return { accessToken: signAccessToken(user), refreshToken, refreshExpiresAt } satisfies IssuedTokens;
}

export const authService = {
  async register(input: RegisterInput, meta: ClientMeta) {
    if (await userRepository.findByEmail(input.email)) {
      throw new AppError('CONFLICT', 'An account with this email already exists');
    }
    const passwordHash = await argon2.hash(input.password, ARGON_OPTS);
    const user = await userRepository.createWithOrganization({
      email: input.email,
      passwordHash,
      name: input.name,
      organizationName: input.organizationName ?? `${input.name ?? input.email.split('@')[0]}'s organization`,
    });
    const organizationId = user.memberships[0]!.organizationId;
    await auditRepository.record({
      organizationId,
      actorUserId: user.id,
      action: 'auth.registered',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip,
    });
    return { user: { id: user.id, email: user.email, name: user.name }, tokens: await issueTokens(user, meta) };
  },

  async login(input: LoginInput, meta: ClientMeta) {
    const user = await userRepository.findByEmail(input.email);
    const valid = user
      ? await argon2.verify(user.passwordHash, input.password)
      : await argon2.verify(await DUMMY_HASH_PROMISE, input.password).then(() => false);
    if (!user || !valid) {
      logger.warn({ ip: meta.ip }, 'Failed login attempt');
      throw new AppError('UNAUTHENTICATED', 'Invalid email or password');
    }
    return { user: { id: user.id, email: user.email, name: user.name }, tokens: await issueTokens(user, meta) };
  },

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole session family. */
  async refresh(refreshToken: string | undefined, meta: ClientMeta) {
    if (!refreshToken) throw new AppError('UNAUTHENTICATED', 'Not signed in');
    const session = await sessionRepository.findByTokenHash(sha256(refreshToken));
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new AppError('UNAUTHENTICATED', 'Session expired');
    }
    if (session.rotatedAt || !(await sessionRepository.markRotated(session.id))) {
      await sessionRepository.revokeFamily(session.familyId);
      logger.warn({ userId: session.userId, ip: meta.ip }, 'Refresh token reuse detected; session family revoked');
      throw new AppError('UNAUTHENTICATED', 'Session expired');
    }
    const user = await userRepository.findWithMemberships(session.userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Session expired');
    return issueTokens(user, meta, session.familyId);
  },

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) return;
    const session = await sessionRepository.findByTokenHash(sha256(refreshToken));
    if (session) await sessionRepository.revokeFamily(session.familyId);
  },

  async me(userId: string) {
    const user = await userRepository.findWithMemberships(userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Not signed in');
    return {
      user: { id: user.id, email: user.email, name: user.name },
      organizations: user.memberships.map((m) => ({ ...m.organization, role: m.role })),
    };
  },
};
