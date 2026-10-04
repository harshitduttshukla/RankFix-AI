import type { RequestHandler } from 'express';
import { crawlService } from '../services/crawler/crawl.service.js';

export const crawlController = {
  start: (async (req, res) => {
    res.status(202).json(await crawlService.start(req.tenant!, res.locals.params.websiteId));
  }) satisfies RequestHandler,

  list: (async (req, res) => {
    res.json({ items: await crawlService.list(req.tenant!, res.locals.params.websiteId) });
  }) satisfies RequestHandler,

  get: (async (req, res) => {
    res.json(await crawlService.get(req.tenant!, res.locals.params.websiteId, res.locals.params.crawlId));
  }) satisfies RequestHandler,

  cancel: (async (req, res) => {
    res.json(await crawlService.cancel(req.tenant!, res.locals.params.websiteId, res.locals.params.crawlId));
  }) satisfies RequestHandler,

  pages: (async (req, res) => {
    res.json(await crawlService.listPages(req.tenant!, res.locals.params.websiteId, res.locals.query ?? {}));
  }) satisfies RequestHandler,

  page: (async (req, res) => {
    res.json(await crawlService.getPage(req.tenant!, res.locals.params.websiteId, res.locals.params.pageId));
  }) satisfies RequestHandler,

  versions: (async (req, res) => {
    res.json(await crawlService.listVersions(req.tenant!, res.locals.params.websiteId, res.locals.params.pageId));
  }) satisfies RequestHandler,
};
