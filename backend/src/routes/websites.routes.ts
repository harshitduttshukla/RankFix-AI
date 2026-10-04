import { Router } from 'express';
import { crawlController } from '../controllers/crawl.controller.js';
import { websiteController } from '../controllers/website.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireWebsiteAccess } from '../middleware/project-access.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { CrawlParams, PageParams, PagesQuery } from '../schemas/content.schema.js';
import { WebsiteParams } from '../schemas/project.schema.js';

export const websiteRoutes = Router();

websiteRoutes.use(requireAuth);

websiteRoutes.get('/:websiteId', validate({ params: WebsiteParams }), requireWebsiteAccess('VIEWER'), websiteController.get);

websiteRoutes.post('/:websiteId/crawl', validate({ params: WebsiteParams }), requireWebsiteAccess('EDITOR'), crawlController.start);
websiteRoutes.get('/:websiteId/crawls', validate({ params: WebsiteParams }), requireWebsiteAccess('VIEWER'), crawlController.list);
websiteRoutes.get('/:websiteId/crawls/:crawlId', validate({ params: CrawlParams }), requireWebsiteAccess('VIEWER'), crawlController.get);
websiteRoutes.post('/:websiteId/crawls/:crawlId/cancel', validate({ params: CrawlParams }), requireWebsiteAccess('EDITOR'), crawlController.cancel);
websiteRoutes.get('/:websiteId/pages', validate({ params: WebsiteParams, query: PagesQuery }), requireWebsiteAccess('VIEWER'), crawlController.pages);
websiteRoutes.get('/:websiteId/pages/:pageId', validate({ params: PageParams }), requireWebsiteAccess('VIEWER'), crawlController.page);
websiteRoutes.get('/:websiteId/pages/:pageId/versions', validate({ params: PageParams }), requireWebsiteAccess('VIEWER'), crawlController.versions);
