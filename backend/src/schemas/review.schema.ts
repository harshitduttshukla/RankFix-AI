import { z } from 'zod';
import { RECOMMENDATION_TYPES } from '../services/ai/ai.schemas.js';
import { Id } from './project.schema.js';

export const CHANGE_TYPE = z.enum(['TITLE', 'META_DESCRIPTION', 'H1', 'SECTION_HEADING', 'SECTION_CONTENT']);
export const REJECTION_REASON = z.enum(['NOT_RELEVANT', 'INCORRECT', 'ALREADY_ADDRESSED', 'NOT_WORTH_CHANGING', 'OTHER']);

export const RecommendationParams = z.object({ projectId: Id, id: Id, recommendationId: Id });
export const ProposalParams = z.object({ projectId: Id, id: Id, proposalId: Id });

export const EditRecommendationBody = z
  .object({
    recommendation: z.string().trim().min(1).max(800).optional(),
    rationale: z.string().trim().min(1).max(800).optional(),
    type: z.enum(RECOMMENDATION_TYPES).optional(),
    targetSection: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

/** A concrete change. currentValue is never accepted from the client; it is read from the analyzed version. */
export const ProposalBody = z.object({
  proposedValue: z.string().min(1).max(20_000),
  changeType: CHANGE_TYPE.optional(),
  targetSection: z.string().trim().min(1).max(200).nullable().optional(),
});

export const RejectRecommendationBody = z.object({
  reason: REJECTION_REASON.optional(),
  note: z.string().trim().max(500).optional(),
});

export const ReasonBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });
export const ApproveProposalBody = z.object({ comment: z.string().trim().max(500).optional() });

export type RejectRecommendationInput = z.infer<typeof RejectRecommendationBody>;
