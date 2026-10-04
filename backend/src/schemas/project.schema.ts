import { z } from 'zod';

export const Id = z.string().min(1).max(64).regex(/^[a-z0-9]+$/i, 'Invalid id');

export const ProjectParams = z.object({ projectId: Id });
export const WebsiteParams = z.object({ websiteId: Id });

export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(100),
  organizationId: Id.optional(),
});

export const CreateWebsiteBody = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    blogPathPrefix: z
      .string()
      .trim()
      .regex(/^\/[A-Za-z0-9\-._~/]*$/, 'Must be a path starting with /')
      .max(200)
      .optional(),
    updateEndpointUrl: z.string().trim().max(2048).optional(),
    updateSecret: z.string().min(32, 'Secret must be at least 32 characters').max(256).optional(),
  })
  .refine((v) => Boolean(v.updateEndpointUrl) === Boolean(v.updateSecret), {
    message: 'updateEndpointUrl and updateSecret must be provided together',
    path: ['updateSecret'],
  });

export type CreateProjectInput = z.infer<typeof CreateProjectBody>;
export type CreateWebsiteInput = z.infer<typeof CreateWebsiteBody>;
