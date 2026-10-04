import { Router } from 'express';
import { gscController } from '../controllers/gsc.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireProjectAccess } from '../middleware/project-access.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { OAuthCallbackQuery, PerformanceQuery, SelectPropertyBody, SyncBody } from '../schemas/gsc.schema.js';
import { ProjectParams } from '../schemas/project.schema.js';

/** Mounted at /api/projects/:projectId/gsc */
export const projectGscRoutes = Router({ mergeParams: true });

projectGscRoutes.use(requireAuth, validate({ params: ProjectParams }));

projectGscRoutes.get('/', requireProjectAccess('VIEWER'), gscController.status);
projectGscRoutes.post('/connect', requireProjectAccess('ADMIN'), gscController.connect);
projectGscRoutes.get('/properties', requireProjectAccess('ADMIN'), gscController.properties);
projectGscRoutes.post('/select-property', requireProjectAccess('ADMIN'), validate({ body: SelectPropertyBody }), gscController.selectProperty);
projectGscRoutes.post('/sync', requireProjectAccess('EDITOR'), validate({ body: SyncBody }), gscController.sync);
projectGscRoutes.get('/performance', requireProjectAccess('VIEWER'), validate({ query: PerformanceQuery }), gscController.performance);
projectGscRoutes.delete('/', requireProjectAccess('ADMIN'), gscController.disconnect);

/** Mounted at /api/gsc — OAuth redirect target (authorization re-checked inside via signed state + session). */
export const gscOAuthRoutes = Router();
gscOAuthRoutes.get('/oauth/callback', validate({ query: OAuthCallbackQuery }), gscController.callback);
