import { Router } from 'express';
import { opportunityController } from '../controllers/opportunity.controller.js';
import { reviewController } from '../controllers/review.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireProjectAccess } from '../middleware/project-access.middleware.js';
import { aiLimiter } from '../middleware/rate-limit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { DismissBody, OpportunitiesQuery, OpportunityParams } from '../schemas/opportunity.schema.js';
import { ProjectParams } from '../schemas/project.schema.js';
import {
  ApproveProposalBody,
  EditRecommendationBody,
  ProposalBody,
  ProposalParams,
  ReasonBody,
  RecommendationParams,
  RejectRecommendationBody,
} from '../schemas/review.schema.js';

/** Mounted at /api/projects/:projectId/optimization */
export const optimizationRoutes = Router({ mergeParams: true });

optimizationRoutes.use(requireAuth, validate({ params: ProjectParams }));

const opp = '/opportunities';
optimizationRoutes.get(opp, requireProjectAccess('VIEWER'), validate({ query: OpportunitiesQuery }), opportunityController.list);
// Registered before /:id so "detect"/"recalculate" are never parsed as an id.
optimizationRoutes.post(`${opp}/detect`, requireProjectAccess('EDITOR'), opportunityController.detect);
optimizationRoutes.post(`${opp}/recalculate`, requireProjectAccess('EDITOR'), opportunityController.detect);
optimizationRoutes.get(`${opp}/:id`, requireProjectAccess('VIEWER'), validate({ params: OpportunityParams }), opportunityController.get);
optimizationRoutes.post(
  `${opp}/:id/dismiss`,
  requireProjectAccess('EDITOR'),
  validate({ params: OpportunityParams, body: DismissBody }),
  opportunityController.dismiss,
);

// Phase 5: AI analysis (queued; results go to human review, never applied automatically).
optimizationRoutes.post(
  `${opp}/:id/analyze`,
  requireProjectAccess('EDITOR'),
  validate({ params: OpportunityParams }),
  aiLimiter,
  opportunityController.analyze,
);
optimizationRoutes.get(`${opp}/:id/analysis`, requireProjectAccess('VIEWER'), validate({ params: OpportunityParams }), opportunityController.analysis);

// Phase 6: human review. Deterministic; never modifies the live site.
const rec = `${opp}/:id/recommendations/:recommendationId`;
const prop = `${opp}/:id/proposals/:proposalId`;
optimizationRoutes.get(`${opp}/:id/review`, requireProjectAccess('VIEWER'), validate({ params: OpportunityParams }), reviewController.get);
optimizationRoutes.patch(rec, requireProjectAccess('EDITOR'), validate({ params: RecommendationParams, body: EditRecommendationBody }), reviewController.edit);
optimizationRoutes.post(`${rec}/approve`, requireProjectAccess('EDITOR'), validate({ params: RecommendationParams, body: ProposalBody }), reviewController.approve);
optimizationRoutes.post(`${rec}/reject`, requireProjectAccess('EDITOR'), validate({ params: RecommendationParams, body: RejectRecommendationBody }), reviewController.reject);
optimizationRoutes.post(`${rec}/proposal`, requireProjectAccess('EDITOR'), validate({ params: RecommendationParams, body: ProposalBody }), reviewController.createProposal);
optimizationRoutes.post(`${prop}/approve`, requireProjectAccess('EDITOR'), validate({ params: ProposalParams, body: ApproveProposalBody }), reviewController.approveProposal);
optimizationRoutes.post(`${prop}/reject`, requireProjectAccess('EDITOR'), validate({ params: ProposalParams, body: ReasonBody }), reviewController.rejectProposal);
optimizationRoutes.post(`${opp}/:id/reject`, requireProjectAccess('EDITOR'), validate({ params: OpportunityParams, body: ReasonBody }), reviewController.rejectOpportunity);
optimizationRoutes.post(`${opp}/:id/reanalyze`, requireProjectAccess('EDITOR'), validate({ params: OpportunityParams }), aiLimiter, reviewController.reanalyze);
