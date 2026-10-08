import { OPPORTUNITY_ANALYSIS_PROMPT_VERSION } from './opportunity-analysis-v1.js';
import { RECOMMENDATION_PROMPT_VERSION } from './recommendation-v1.js';

export * from './opportunity-analysis-v1.js';
export * from './recommendation-v1.js';

/** Recorded on every AIAnalysisRun and OpportunityAnalysis. */
export const ANALYSIS_PROMPT_VERSION = `${OPPORTUNITY_ANALYSIS_PROMPT_VERSION}+${RECOMMENDATION_PROMPT_VERSION}`;
