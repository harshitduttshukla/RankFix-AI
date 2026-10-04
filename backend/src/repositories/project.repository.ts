import { prisma } from '../config/database.js';
import type { Db } from './types.js';

export const projectRepository = {
  /** Projects in every organization the user belongs to, with the user's role. */
  async listForUser(userId: string, db: Db = prisma) {
    const memberships = await db.membership.findMany({
      where: { userId },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            name: true,
            projects: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true, createdAt: true } },
          },
        },
      },
    });
    return memberships.flatMap((m) =>
      m.organization.projects.map((p) => ({
        ...p,
        organizationId: m.organization.id,
        organizationName: m.organization.name,
        role: m.role,
      })),
    );
  },

  findMembership(userId: string, organizationId: string, db: Db = prisma) {
    return db.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  },

  /** Membership-joined lookup: returns null unless the user belongs to the project's organization. */
  async findAccessible(projectId: string, userId: string, db: Db = prisma) {
    const project = await db.project.findFirst({
      where: { id: projectId, organization: { memberships: { some: { userId } } } },
      select: {
        id: true,
        name: true,
        organizationId: true,
        createdAt: true,
        organization: { select: { memberships: { where: { userId }, select: { role: true } } } },
      },
    });
    const role = project?.organization.memberships[0]?.role;
    if (!project || !role) return null;
    const { organization: _org, ...rest } = project;
    return { project: rest, role };
  },

  create(organizationId: string, name: string, db: Db = prisma) {
    return db.project.create({ data: { organizationId, name }, select: { id: true, name: true, organizationId: true, createdAt: true } });
  },
};
