import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import type { Db } from './types.js';

export interface AuditEntry {
  organizationId: string;
  projectId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

export const auditRepository = {
  record(entry: AuditEntry, db: Db = prisma) {
    return db.auditLog.create({ data: entry });
  },

  list(organizationId: string, projectId: string, db: Db = prisma) {
    return db.auditLog.findMany({ where: { organizationId, projectId }, orderBy: { createdAt: 'desc' }, take: 200 });
  },
};
