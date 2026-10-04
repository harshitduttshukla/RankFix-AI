import { z } from 'zod';
import { Id } from './project.schema.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const SelectPropertyBody = z.object({
  websiteId: Id,
  siteUrl: z.string().trim().min(1).max(2048),
});

export const SyncBody = z.object({
  websiteId: Id.optional(),
  days: z.number().int().min(1).max(480).optional(),
});

export const PerformanceQuery = z
  .object({
    websiteId: Id.optional(),
    pageUrl: z.string().max(2048).optional(),
    start: isoDate.optional(),
    end: isoDate.optional(),
  })
  .refine((q) => !q.start || !q.end || q.start <= q.end, { message: 'start must be before end', path: ['start'] });

export const OAuthCallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(4096).optional(),
  error: z.string().max(200).optional(),
});

export type SelectPropertyInput = z.infer<typeof SelectPropertyBody>;
export type SyncInput = z.infer<typeof SyncBody>;
export type PerformanceInput = z.infer<typeof PerformanceQuery>;
