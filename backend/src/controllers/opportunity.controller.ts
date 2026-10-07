import type { RequestHandler } from 'express';
import { opportunityService } from '../services/optimization/opportunity.service.js';

export const opportunityController = {
  list: (async (req, res) => {
    res.json(await opportunityService.list(req.tenant!, res.locals.query));
  }) satisfies RequestHandler,

  get: (async (req, res) => {
    res.json(await opportunityService.get(req.tenant!, res.locals.params.id));
  }) satisfies RequestHandler,

  detect: (async (req, res) => {
    res.status(202).json(await opportunityService.detect(req.tenant!));
  }) satisfies RequestHandler,

  dismiss: (async (req, res) => {
    res.json(await opportunityService.dismiss(req.tenant!, res.locals.params.id, req.body));
  }) satisfies RequestHandler,
};
