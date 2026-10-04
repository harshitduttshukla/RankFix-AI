import { prisma } from '../../config/database.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { projectRepository } from '../../repositories/project.repository.js';
import type { CreateProjectInput } from '../../schemas/project.schema.js';
import { ROLE_RANK } from '../../types/tenant.js';
import { AppError } from '../../utils/errors.js';

export const projectService = {
  list(userId: string) {
    return projectRepository.listForUser(userId);
  },

  async create(userId: string, input: CreateProjectInput) {
    let organizationId = input.organizationId;
    if (organizationId) {
      const membership = await projectRepository.findMembership(userId, organizationId);
      if (!membership) throw new AppError('NOT_FOUND', 'Organization not found');
      if (ROLE_RANK[membership.role] < ROLE_RANK.ADMIN) throw new AppError('FORBIDDEN', 'Requires ADMIN role or higher');
    } else {
      const memberships = await prisma.membership.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
      organizationId = memberships.find((m) => ROLE_RANK[m.role] >= ROLE_RANK.ADMIN)?.organizationId;
      if (!organizationId) throw new AppError('FORBIDDEN', 'No organization where you can create projects');
    }
    const orgId = organizationId;
    return prisma.$transaction(async (tx) => {
      const project = await projectRepository.create(orgId, input.name, tx);
      await auditRepository.record(
        { organizationId: orgId, projectId: project.id, actorUserId: userId, action: 'project.created', entityType: 'Project', entityId: project.id },
        tx,
      );
      return project;
    });
  },
};
