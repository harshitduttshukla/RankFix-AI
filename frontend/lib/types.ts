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

export type OpportunityType = "LOW_CTR" | "PAGE_ONE_NEAR_TOP" | "HIGH_IMPRESSIONS_LOW_CLICKS" | "PERFORMANCE_DECLINE" | "CONTENT_COVERAGE_SIGNAL";
export type OpportunityStatus =
  | "DETECTED" | "REVIEWED" | "ANALYZING" | "PROPOSED" | "AWAITING_APPROVAL" | "APPROVED" | "APPLYING"
  | "APPLIED" | "MEASURING" | "COMPLETED" | "REJECTED" | "FAILED" | "DISMISSED";

export interface DetectionRun {
  id: string;
  trigger: "MANUAL" | "GSC_SYNC";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  websitesEvaluated: number;
  pagesEvaluated: number;
  created: number;
  updated: number;
  cleared: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface OpportunityRow {
  id: string;
  websiteId: string;
  pageId: string;
  pageUrl: string;
  pageTitle: string | null;
  type: OpportunityType;
  score: number;
  status: OpportunityStatus;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  dateRangeStart: string;
  dateRangeEnd: string;
  reasons: string[];
  lastDetectedAt: string;
}

export interface Evidence {
  type: string;
  primary: boolean;
  metric: string;
  unit: "count" | "percent" | "position";
  value: number;
  threshold?: number;
  thresholdMax?: number;
  comparison?: "<" | ">=" | "between";
  previousValue?: number;
  query?: string;
  missingTerms?: string[];
  text: string;
}

export interface QueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export interface PeriodMetrics extends Metrics {
  start: string;
  end: string;
}

export interface OpportunityDetail extends Omit<OpportunityRow, "reasons"> {
  scoreBreakdown: { component: string; value: number; weight: number; points: number }[];
  metrics: {
    current: PeriodMetrics;
    previous: PeriodMetrics;
    expectedCtr: number | null;
    queryCount: number;
    clickChangePercent: number | null;
    ctrChangePercent: number | null;
    positionChange: number | null;
    summary: string;
  };
  evidence: Evidence[];
  topQueries: QueryRow[];
  dismissReason: string | null;
  dismissedAt: string | null;
  page: {
    id: string;
    websiteId: string;
    url: string;
    status: PageStatus;
    lastCrawledAt: string;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    wordCount: number | null;
    versionNo: number | null;
  };
}

// ── Phase 5/6: AI analysis & human review ──

export type AnalysisState = "NO_ANALYSIS" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "STALE";
export type RecommendationType = "TITLE" | "META_DESCRIPTION" | "HEADING" | "SECTION_EXPANSION" | "MISSING_TOPIC" | "CLARIFICATION" | "INTERNAL_LINK" | "INTRODUCTION";
export type ChangeType = "TITLE" | "META_DESCRIPTION" | "H1" | "SECTION_HEADING" | "SECTION_CONTENT";
export type RejectionReason = "NOT_RELEVANT" | "INCORRECT" | "ALREADY_ADDRESSED" | "NOT_WORTH_CHANGING" | "OTHER";

export interface AIRun {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  model: string;
  promptVersion: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Recommendation {
  type: RecommendationType;
  recommendation: string;
  rationale: string;
  evidence: string[];
  targetSection: string | null;
  priority: "HIGH" | "MEDIUM" | "LOW";
}

export interface Analysis {
  id: string;
  createdAt: string;
  model: string;
  pageVersionId: string | null;
  pageVersionNo: number | null;
  stale: boolean;
  staleReason: "PAGE_VERSION_CHANGED" | "EVIDENCE_CHANGED" | null;
  summary: string;
  evidenceSufficient: boolean;
  insufficientEvidenceNotes: string[];
  observations: { type: string; statement: string; evidence: string[] }[];
  interpretations: { statement: string; basedOn: string[]; confidence: number }[];
  searchIntent: { query: string; intent: string; confidence: number; reasoning: string }[];
  contentGaps: { topic: string; relatedQueries: string[]; evidence: string; confidence: number }[];
  areasForInvestigation: string[];
  caveats: string[];
}

export interface Proposal {
  id: string;
  changeType: ChangeType;
  targetSection: string | null;
  currentValue: string | null;
  proposedValue: string;
  source: "AI_RECOMMENDATION" | "HUMAN_EDITED";
  revision: number;
  status: "AWAITING_APPROVAL" | "APPROVED" | "REJECTED" | "APPLIED" | "SUPERSEDED" | "FAILED";
  pageVersionId: string;
  pageVersionNo: number;
  matchesCurrentPageVersion: boolean;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface RecommendationReview {
  id: string;
  index: number;
  status: "PENDING" | "EDITED" | "APPROVED" | "REJECTED";
  original: Recommendation;
  edited: Recommendation | null;
  effective: Recommendation;
  editedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: RejectionReason | null;
  rejectionNote: string | null;
  suggestedChangeType: ChangeType | null;
  currentValue: string | null;
  proposals: Proposal[];
}

export interface ReviewPayload {
  opportunity: OpportunityDetail;
  page: {
    id: string;
    url: string;
    status: PageStatus;
    lastCrawledAt: string;
    currentVersionId: string | null;
    currentVersion: null | {
      id: string;
      versionNo: number;
      title: string | null;
      metaDescription: string | null;
      canonicalUrl: string | null;
      h1: string | null;
      headings: { level: number; text: string; order: number }[];
      wordCount: number;
      createdAt: string;
      pageSections: { sectionKey: string; heading: string | null; level: number; wordCount: number }[];
    };
  };
  analysisState: AnalysisState;
  latestRun: AIRun | null;
  analysis: Analysis | null;
  recommendations: RecommendationReview[];
}
