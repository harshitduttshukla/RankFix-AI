import { z } from 'zod';
import { Id } from './project.schema.js';

export const OPPORTUNITY_TYPES = ['LOW_CTR', 'PAGE_ONE_NEAR_TOP', 'HIGH_IMPRESSIONS_LOW_CLICKS', 'PERFORMANCE_DECLINE', 'CONTENT_COVERAGE_SIGNAL'] as const;

export const OpportunityParams = z.object({ projectId: Id, id: Id });

export const OpportunitiesQuery = z.object({
  /** open = DETECTED + REVIEWED (default); all = every status. */
  status: z.enum(['open', 'dismissed', 'all']).default('open'),
  type: z.enum(OPPORTUNITY_TYPES).optional(),
  websiteId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const DismissBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

export type OpportunitiesInput = z.infer<typeof OpportunitiesQuery>;
export type DismissInput = z.infer<typeof DismissBody>;
