import { Router } from 'express';
import { opportunityController } from '../controllers/opportunity.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireProjectAccess } from '../middleware/project-access.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { DismissBody, OpportunitiesQuery, OpportunityParams } from '../schemas/opportunity.schema.js';
import { ProjectParams } from '../schemas/project.schema.js';

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
