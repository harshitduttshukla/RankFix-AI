import { prisma } from '../config/database.js';
import type { TenantContext } from '../types/tenant.js';
import type { Db } from './types.js';

/** Public shape: secrets are never selected. */
const websiteSelect = {
  id: true,
  organizationId: true,
  projectId: true,
  baseUrl: true,
  hostname: true,
  blogPathPrefix: true,
  updateProvider: true,
  updateEndpointUrl: true,
  updateSecretEnc: false,
  lastCrawledAt: true,
  createdAt: true,
} as const;

export const websiteRepository = {
  create(
    tenant: TenantContext,
    data: { baseUrl: string; hostname: string; blogPathPrefix?: string; updateEndpointUrl?: string; updateSecretEnc?: string },
    db: Db = prisma,
  ) {
    return db.website.create({
      data: { ...data, organizationId: tenant.organizationId, projectId: tenant.projectId },
      select: { ...websiteSelect, updateSecretEnc: true },
    });
  },

  listByProject(tenant: TenantContext, db: Db = prisma) {
    return db.website.findMany({
      where: { organizationId: tenant.organizationId, projectId: tenant.projectId },
      orderBy: { createdAt: 'asc' },
      select: { ...websiteSelect, updateSecretEnc: true },
    });
  },

  /** Unscoped lookup used only to resolve a website's project before the membership check. */
  findProjectRef(websiteId: string, db: Db = prisma) {
    return db.website.findUnique({ where: { id: websiteId }, select: { projectId: true } });
  },

  findById(tenant: TenantContext, websiteId: string, db: Db = prisma) {
    return db.website.findFirst({
      where: { id: websiteId, organizationId: tenant.organizationId, projectId: tenant.projectId },
      select: { ...websiteSelect, updateSecretEnc: true },
    });
  },
};
