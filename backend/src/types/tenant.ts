import type { OrgRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
}

/** Resolved server-side from membership; never taken from client input. */
export interface TenantContext {
  organizationId: string;
  projectId: string;
  role: OrgRole;
  userId: string;
}

export const ROLE_RANK: Record<OrgRole, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };
