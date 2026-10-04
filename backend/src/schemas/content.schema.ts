import { z } from 'zod';
import { Id } from './project.schema.js';

export const CrawlParams = z.object({ websiteId: Id, crawlId: Id });
export const PageParams = z.object({ websiteId: Id, pageId: Id });

export const PagesQuery = z.object({
  status: z.enum(['ACTIVE', 'GONE', 'EXCLUDED', 'REDIRECTED', 'ERROR']).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
