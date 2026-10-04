import type { RequestHandler } from 'express';
import type { z } from 'zod';

interface Schemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

/**
 * Validates request parts. Parsed body replaces req.body; parsed params/query are
 * placed on res.locals (Express 5 makes req.query read-only).
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, res, next) => {
    try {
      if (schemas.params) res.locals.params = schemas.params.parse(req.params);
      if (schemas.query) res.locals.query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
