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
