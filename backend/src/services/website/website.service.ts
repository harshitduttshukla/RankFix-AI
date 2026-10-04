import { prisma } from '../../config/database.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { websiteRepository } from '../../repositories/website.repository.js';
import type { CreateWebsiteInput } from '../../schemas/project.schema.js';
import type { TenantContext } from '../../types/tenant.js';
import { encryptSecret } from '../../utils/crypto.js';
import { AppError, notFound } from '../../utils/errors.js';
import { isSameSite, normalizeBaseUrl } from '../../utils/url.js';

type WebsiteRow = NonNullable<Awaited<ReturnType<typeof websiteRepository.findById>>>;

/** Strips the encrypted secret; exposes only whether one is configured. */
export function toWebsiteDto({ updateSecretEnc, ...rest }: WebsiteRow) {
  return { ...rest, hasUpdateSecret: Boolean(updateSecretEnc) };
}

export const websiteService = {
  async create(tenant: TenantContext, input: CreateWebsiteInput) {
    const { baseUrl, hostname } = normalizeBaseUrl(input.baseUrl);

    let updateEndpointUrl: string | undefined;
    if (input.updateEndpointUrl) {
      const endpoint = normalizeBaseUrl(input.updateEndpointUrl); // same safety rules as the site URL
      const url = new URL(input.updateEndpointUrl);
      if (url.protocol !== 'https:') throw new AppError('VALIDATION_ERROR', 'Update endpoint must use https');
      if (!isSameSite(endpoint.baseUrl, hostname)) {
        throw new AppError('VALIDATION_ERROR', 'Update endpoint must be on the website domain');
      }
      updateEndpointUrl = `${endpoint.baseUrl}${url.pathname.replace(/\/+$/, '')}`;
    }

    const website = await prisma.$transaction(async (tx) => {
      const created = await websiteRepository.create(
        tenant,
        {
          baseUrl,
          hostname,
          blogPathPrefix: input.blogPathPrefix,
          updateEndpointUrl,
          updateSecretEnc: input.updateSecret ? encryptSecret(input.updateSecret) : undefined,
        },
        tx,
      );
      await auditRepository.record(
        {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          actorUserId: tenant.userId,
          action: 'website.created',
          entityType: 'Website',
          entityId: created.id,
          metadata: { baseUrl },
        },
        tx,
      );
      return created;
    });
    return toWebsiteDto(website);
  },

  async list(tenant: TenantContext) {
    return (await websiteRepository.listByProject(tenant)).map(toWebsiteDto);
  },

  async get(tenant: TenantContext, websiteId: string) {
    const website = await websiteRepository.findById(tenant, websiteId);
    if (!website) throw notFound('Website');
    return toWebsiteDto(website);
  },
};
