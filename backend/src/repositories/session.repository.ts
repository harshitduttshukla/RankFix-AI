import { prisma } from '../config/database.js';
import type { Db } from './types.js';

export const sessionRepository = {
  create(
    data: { userId: string; familyId: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string },
    db: Db = prisma,
  ) {
    return db.session.create({ data });
  },

  findByTokenHash(tokenHash: string, db: Db = prisma) {
    return db.session.findUnique({ where: { tokenHash } });
  },

  /** Atomically marks a live session rotated. Returns false if it was already rotated/revoked (race or reuse). */
  async markRotated(id: string, db: Db = prisma) {
    const res = await db.session.updateMany({
      where: { id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: new Date() },
    });
    return res.count === 1;
  },

  revokeFamily(familyId: string, db: Db = prisma) {
    return db.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  },
};
