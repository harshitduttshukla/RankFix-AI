import type { AuthUser, TenantContext } from './tenant.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenant?: TenantContext;
    }
  }
}

export {};
