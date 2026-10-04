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

export type CrawlStatus = "PENDING" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";
export type PageStatus = "ACTIVE" | "GONE" | "EXCLUDED" | "REDIRECTED" | "ERROR";
export type ExtractionMethod = "HTTP_CHEERIO" | "PLAYWRIGHT";

export interface CrawlJob {
  id: string;
  websiteId: string;
  status: CrawlStatus;
  discoveryMethod: string | null;
  robotsFound: boolean | null;
  pagesDiscovered: number;
  pagesProcessed: number;
  pagesSucceeded: number;
  pagesFailed: number;
  pagesSkipped: number;
  pagesCreated: number;
  pagesUpdated: number;
  pagesUnchanged: number;
  renderedPages: number;
  error: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CrawlPageResult {
  url: string;
  finalUrl: string | null;
  outcome: "CREATED" | "UPDATED" | "UNCHANGED" | "SKIPPED" | "FAILED";
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
}

export interface CrawlDetail extends CrawlJob {
  failures: CrawlPageResult[];
  skipped: CrawlPageResult[];
}

export interface PageRow {
  id: string;
  url: string;
  status: PageStatus;
  httpStatus: number;
  canonicalUrl: string | null;
  redirectedTo: string | null;
  noindex: boolean;
  lastCrawledAt: string;
  currentVersionNo: number;
  title: string | null;
  wordCount: number | null;
  extractionMethod: ExtractionMethod | null;
}

export interface ContentBlock {
  type: string;
  text: string;
  items?: string[];
  src?: string;
  alt?: string | null;
}

export interface PageDetail {
  id: string;
  url: string;
  status: PageStatus;
  httpStatus: number;
  canonicalUrl: string | null;
  redirectedTo: string | null;
  noindex: boolean;
  lastCrawledAt: string;
  currentVersionNo: number;
  currentVersion: null | {
    id: string;
    versionNo: number;
    title: string | null;
    metaDescription: string | null;
    canonicalUrl: string | null;
    language: string | null;
    robotsMeta: string | null;
    seoMeta: { og: Record<string, string>; twitter: Record<string, string>; charset: string | null; viewport: string | null };
    h1: string | null;
    headings: { level: number; text: string; order: number }[];
    wordCount: number;
    contentHash: string;
    extractionMethod: ExtractionMethod | null;
    crawlerVersion: string | null;
    invalidJsonLd: number;
    createdAt: string;
    pageSections: { sectionKey: string; order: number; heading: string | null; level: number; text: string; wordCount: number; blocks: ContentBlock[] }[];
    links: { targetUrl: string; anchorText: string; isInternal: boolean; inContent: boolean; rel: string[]; nofollow: boolean }[];
    images: { src: string; alt: string | null; title: string | null; width: number | null; height: number | null; inContent: boolean }[];
    structuredData: { types: string[]; data: unknown }[];
  };
}

export interface PageVersion {
  id: string;
  versionNo: number;
  source: string;
  title: string | null;
  wordCount: number;
  contentHash: string;
  extractionMethod: ExtractionMethod | null;
  createdAt: string;
}
