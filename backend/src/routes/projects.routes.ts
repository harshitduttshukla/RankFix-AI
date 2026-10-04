import { Router } from 'express';
import { projectController } from '../controllers/project.controller.js';
import { websiteController } from '../controllers/website.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireProjectAccess } from '../middleware/project-access.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { CreateProjectBody, CreateWebsiteBody, ProjectParams } from '../schemas/project.schema.js';

export const projectRoutes = Router();

projectRoutes.use(requireAuth);

projectRoutes.get('/', projectController.list);
projectRoutes.post('/', validate({ body: CreateProjectBody }), projectController.create);

projectRoutes.get('/:projectId', validate({ params: ProjectParams }), requireProjectAccess('VIEWER'), projectController.get);

projectRoutes.get(
  '/:projectId/websites',
  validate({ params: ProjectParams }),
  requireProjectAccess('VIEWER'),
  websiteController.list,
);
projectRoutes.post(
  '/:projectId/websites',
  validate({ params: ProjectParams, body: CreateWebsiteBody }),
  requireProjectAccess('ADMIN'),
  websiteController.create,
);
