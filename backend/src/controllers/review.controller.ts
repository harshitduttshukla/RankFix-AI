import type { RequestHandler } from 'express';
import { reviewService } from '../services/review/review.service.js';

const p = (res: { locals: Record<string, any> }) => res.locals.params as { id: string; recommendationId?: string; proposalId?: string };

export const reviewController = {
  get: (async (req, res) => {
    res.json(await reviewService.getReview(req.tenant!, p(res).id));
  }) satisfies RequestHandler,

  edit: (async (req, res) => {
    res.json(await reviewService.editRecommendation(req.tenant!, p(res).id, p(res).recommendationId!, req.body));
  }) satisfies RequestHandler,

  approve: (async (req, res) => {
    res.json(await reviewService.approveRecommendation(req.tenant!, p(res).id, p(res).recommendationId!, req.body));
  }) satisfies RequestHandler,

  reject: (async (req, res) => {
    res.json(await reviewService.rejectRecommendation(req.tenant!, p(res).id, p(res).recommendationId!, req.body));
  }) satisfies RequestHandler,

  createProposal: (async (req, res) => {
    res.status(201).json(await reviewService.createProposal(req.tenant!, p(res).id, p(res).recommendationId!, req.body));
  }) satisfies RequestHandler,

  approveProposal: (async (req, res) => {
    res.json(await reviewService.approveProposal(req.tenant!, p(res).id, p(res).proposalId!, req.body.comment));
  }) satisfies RequestHandler,

  rejectProposal: (async (req, res) => {
    res.json(await reviewService.rejectProposal(req.tenant!, p(res).id, p(res).proposalId!, req.body.reason));
  }) satisfies RequestHandler,

  rejectOpportunity: (async (req, res) => {
    res.json(await reviewService.rejectOpportunity(req.tenant!, p(res).id, req.body.reason));
  }) satisfies RequestHandler,

  reanalyze: (async (req, res) => {
    res.status(202).json(await reviewService.reanalyze(req.tenant!, p(res).id));
  }) satisfies RequestHandler,
};
