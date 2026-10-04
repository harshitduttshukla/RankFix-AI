import { prisma } from '../config/database.js';
import type { Db } from './types.js';

export const userRepository = {
  findByEmail(email: string, db: Db = prisma) {
    return db.user.findUnique({ where: { email } });
  },

  findWithMemberships(id: string, db: Db = prisma) {
    return db.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        memberships: { select: { role: true, organization: { select: { id: true, name: true } } } },
      },
    });
  },

  /** New user gets their own organization as OWNER. */
  createWithOrganization(
    data: { email: string; passwordHash: string; name?: string; organizationName: string },
    db: Db = prisma,
  ) {
    return db.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name,
        memberships: { create: { role: 'OWNER', organization: { create: { name: data.organizationName } } } },
      },
      select: { id: true, email: true, name: true, memberships: { select: { organizationId: true } } },
    });
  },
};
