import type { RequestHandler } from 'express';
import { websiteService } from '../services/website/website.service.js';

export const websiteController = {
  create: (async (req, res) => {
    res.status(201).json(await websiteService.create(req.tenant!, req.body));
  }) satisfies RequestHandler,

  list: (async (req, res) => {
    res.json({ items: await websiteService.list(req.tenant!) });
  }) satisfies RequestHandler,

  get: (async (req, res) => {
    res.json(await websiteService.get(req.tenant!, res.locals.params.websiteId));
  }) satisfies RequestHandler,
};
