export type OrgRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface Me {
  user: User;
  organizations: { id: string; name: string; role: OrgRole }[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  role: OrgRole;
  createdAt: string;
}

export interface Website {
  id: string;
  projectId: string;
  baseUrl: string;
  hostname: string;
  blogPathPrefix: string | null;
  updateProvider: "SITE_UPDATE_API";
  updateEndpointUrl: string | null;
  hasUpdateSecret: boolean;
  lastCrawledAt: string | null;
  createdAt: string;
}

export type SyncStatus = "IDLE" | "QUEUED" | "RUNNING" | "FAILED";

export interface GscPropertyMapping {
  id: string;
  websiteId: string;
  siteUrl: string;
  permissionLevel: string;
  syncStatus: SyncStatus;
  syncError: string | null;
  lastSyncedAt: string | null;
  lastSyncedDate: string | null;
  website: { baseUrl: string; hostname: string };
}

export interface GscStatus {
  connected: boolean;
  revoked: boolean;
  googleEmail: string | null;
  connectedAt: string | null;
  properties: GscPropertyMapping[];
}

export interface GscAvailableProperty {
  siteUrl: string;
  permissionLevel: string;
  matchingWebsiteIds: string[];
  mappedWebsiteIds: string[];
}

export interface Metrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export interface SitePerformance {
  window: { start: string; end: string };
  totals: Metrics;
  daily: (Metrics & { date: string })[];
  pages: (Metrics & { page: string })[];
}
