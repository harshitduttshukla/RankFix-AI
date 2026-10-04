import type { OrgRole } from '@prisma/client';
import type { RequestHandler } from 'express';
import { projectRepository } from '../repositories/project.repository.js';
import { websiteRepository } from '../repositories/website.repository.js';
import { ROLE_RANK } from '../types/tenant.js';
import { AppError, notFound } from '../utils/errors.js';

async function resolveTenant(projectId: string, userId: string, minRole: OrgRole) {
  const access = await projectRepository.findAccessible(projectId, userId);
  // Non-members get 404, not 403, so project ids from other tenants are not confirmable.
  if (!access) throw notFound('Project');
  if (ROLE_RANK[access.role] < ROLE_RANK[minRole]) {
    throw new AppError('FORBIDDEN', `Requires ${minRole} role or higher`);
  }
  return { organizationId: access.project.organizationId, projectId: access.project.id, role: access.role, userId };
}

/** For /projects/:projectId/* routes. Must run after requireAuth. */
export const requireProjectAccess =
  (minRole: OrgRole = 'VIEWER'): RequestHandler =>
  async (req, _res, next) => {
    try {
      const projectId = req.params.projectId;
      if (!req.user || typeof projectId !== 'string') throw new AppError('UNAUTHENTICATED', 'Not signed in');
      req.tenant = await resolveTenant(projectId, req.user.id, minRole);
      next();
    } catch (err) {
      next(err);
    }
  };

/** For /websites/:websiteId/* routes: resolves website → project, then the same membership check. */
export const requireWebsiteAccess =
  (minRole: OrgRole = 'VIEWER'): RequestHandler =>
  async (req, _res, next) => {
    try {
      const websiteId = req.params.websiteId;
      if (!req.user || typeof websiteId !== 'string') throw new AppError('UNAUTHENTICATED', 'Not signed in');
      const ref = await websiteRepository.findProjectRef(websiteId);
      if (!ref) throw notFound('Website');
      try {
        req.tenant = await resolveTenant(ref.projectId, req.user.id, minRole);
      } catch (err) {
        throw err instanceof AppError && err.code === 'NOT_FOUND' ? notFound('Website') : err;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
