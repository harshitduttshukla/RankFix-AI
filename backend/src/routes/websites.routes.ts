import { Router } from 'express';
import { websiteController } from '../controllers/website.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireWebsiteAccess } from '../middleware/project-access.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { WebsiteParams } from '../schemas/project.schema.js';

export const websiteRoutes = Router();

websiteRoutes.use(requireAuth);

websiteRoutes.get('/:websiteId', validate({ params: WebsiteParams }), requireWebsiteAccess('VIEWER'), websiteController.get);
