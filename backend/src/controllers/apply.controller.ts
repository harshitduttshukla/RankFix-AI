import type { RequestHandler } from 'express';
import { applyService } from '../services/apply/apply.service.js';
import { reviewService } from '../services/review/review.service.js';

const p = (res: { locals: Record<string, any> }) => res.locals.params as { id: string; proposalId?: string };

export const applyController = {
  /** 202: verification is queued; the review payload carries the run's state. */
  markApplied: (async (req, res) => {
    const { queued } = await applyService.markApplied(req.tenant!, p(res).id, p(res).proposalId!);
    res.status(202).json({ queued, review: await reviewService.getReview(req.tenant!, p(res).id) });
  }) satisfies RequestHandler,

  abandon: (async (req, res) => {
    await applyService.abandon(req.tenant!, p(res).id, req.body.reason);
    res.json(await reviewService.getReview(req.tenant!, p(res).id));
  }) satisfies RequestHandler,
};
