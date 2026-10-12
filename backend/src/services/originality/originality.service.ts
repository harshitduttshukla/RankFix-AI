import { createHash } from 'node:crypto';
import type { Prisma, ProposalChangeType } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import type { TenantContext } from '../../types/tenant.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { InternalCorpusChecker } from './internal-corpus.checker.js';
import { originalityConfig, type OriginalityConfig } from './originality.config.js';
import type { OriginalityAssessment, OriginalityChecker, OriginalityMatch, SourceField } from './originality.types.js';
import { normalizeForMatch } from './fingerprint.js';

/*
 * Originality checks for AI-draftable fields (title, meta description, H1, section heading, intro text).
 * Separate from factual grounding and overclaim validation (drafts.ts), which still run unchanged.
 * Results are append-only rows bound to the exact text and analyzed page version; a different text is a new check.
 */

let override: OriginalityChecker | null | undefined;

/** Tests inject a checker (or null for "none"); undefined resets to the configured one. */
export function setOriginalityChecker(c: OriginalityChecker | null | undefined) {
  override = c;
}

function checker(cfg: OriginalityConfig): OriginalityChecker | null {
  if (override !== undefined) return override;
  return cfg.checker === 'none' ? null : new InternalCorpusChecker(cfg);
}

interface VersionLike {
  sections: { sectionKey: string; heading: string | null }[];
}

/** The page field a change replaces, when that field is subject to originality checks; otherwise null. */
export function originalityTarget(changeType: ProposalChangeType, targetSection: string | null, values: VersionLike): { field: SourceField; sectionKey: string | null } | null {
  if (changeType === 'TITLE' || changeType === 'META_DESCRIPTION' || changeType === 'H1') return { field: changeType, sectionKey: null };
  if (changeType === 'SECTION_HEADING') return targetSection ? { field: 'SECTION_HEADING', sectionKey: targetSection } : null;
  // Section text of any existing section (intro and body rewrites alike).
  if (changeType === 'SECTION_CONTENT' && targetSection && values.sections.some((s) => s.sectionKey === targetSection)) return { field: 'SECTION_TEXT', sectionKey: targetSection };
  return null;
}

export const textHash = (text: string) => createHash('sha256').update(normalizeForMatch(text)).digest('hex');

type CheckRow = Prisma.OriginalityCheckGetPayload<object>;

export function checkView(row: CheckRow, cfg = originalityConfig()) {
  return {
    id: row.id,
    status: row.status as 'CHECKED' | 'CHECK_FAILED',
    assessment: row.assessment as OriginalityAssessment | null,
    overlapRatio: row.overlapRatio,
    matches: row.matches as unknown as OriginalityMatch[],
    corpusPages: row.corpusPages,
    checker: row.checker,
    checkerVersion: row.checkerVersion,
    checkedAt: row.createdAt,
    /** After this the result is no longer reused for approval (the corpus may have changed). */
    reusableUntil: new Date(row.createdAt.getTime() + cfg.resultTtlMs),
    limitations: row.limitations as unknown as string[],
    error: row.errorCode ? { code: row.errorCode, message: row.errorMessage } : null,
    text: row.text,
    textHash: row.textHash,
    changeType: row.changeType,
    targetSection: row.targetSection,
    draftId: row.draftId,
  };
}
export type CheckView = ReturnType<typeof checkView>;

export interface CheckSubject {
  opp: { id: string; websiteId: string; pageId: string };
  review: { id: string };
  version: { id: string };
  values: VersionLike;
}

export interface CheckChange {
  changeType: ProposalChangeType;
  targetSection: string | null;
  text: string;
  draftId?: string | null;
}

export type OriginalityDecision =
  | { status: 'NOT_CHECKED'; check: null; acknowledged: false }
  | { status: 'CHECKED' | 'CHECK_FAILED'; check: CheckView; acknowledged: boolean };

export const originalityService = {
  config: originalityConfig,

  /** Runs a new check and stores it (CHECKED or CHECK_FAILED). Never throws for checker failures. */
  async run(tenant: TenantContext, s: CheckSubject, change: CheckChange, cfg = originalityConfig()): Promise<CheckView> {
    const target = originalityTarget(change.changeType, change.targetSection, s.values);
    if (!target) throw new AppError('VALIDATION_ERROR', 'Originality checks apply to the title, meta description, H1, section headings and existing section text');
    const c = checker(cfg);
    if (!c) throw new AppError('VALIDATION_ERROR', 'Originality checking is disabled on this server');
    const normalized = change.changeType === 'SECTION_CONTENT' ? change.text.trim() : change.text.replace(/\s+/g, ' ').trim();
    if (!normalizeForMatch(normalized)) throw new AppError('VALIDATION_ERROR', 'Nothing to check: the text is empty');

    const base = {
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      websiteId: s.opp.websiteId,
      opportunityId: s.opp.id,
      recommendationReviewId: s.review.id,
      pageId: s.opp.pageId,
      pageVersionId: s.version.id,
      draftId: change.draftId ?? null,
      changeType: change.changeType,
      targetSection: target.sectionKey,
      text: normalized,
      textHash: textHash(normalized),
      checker: c.name,
      checkerVersion: c.version,
      checkedById: tenant.userId,
    };
    let data: Prisma.OriginalityCheckUncheckedCreateInput;
    try {
      const out = await c.check(
        { organizationId: tenant.organizationId, projectId: tenant.projectId },
        { text: normalized, pageId: s.opp.pageId, websiteId: s.opp.websiteId, replacing: target },
      );
      data = {
        ...base,
        status: 'CHECKED',
        assessment: out.assessment,
        overlapRatio: out.overlapRatio,
        matches: out.matches as unknown as Prisma.InputJsonValue,
        corpusPages: out.corpusPages,
        limitations: out.limitations,
      };
    } catch (err) {
      // Logged without the text; the stored message is our own wording.
      logger.warn({ reviewId: s.review.id, checker: c.name, err: err instanceof Error ? err.name : 'unknown' }, 'originality check failed');
      data = {
        ...base,
        status: 'CHECK_FAILED',
        matches: [],
        limitations: ['The check did not complete, so nothing is known about this text’s overlap with other pages.'],
        errorCode: (err as { code?: string })?.code ?? 'CHECKER_ERROR',
        errorMessage: 'The originality checker failed; run the check again.',
      };
    }
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.originalityCheck.create({ data });
      await auditRepository.record(
        {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          actorUserId: tenant.userId,
          action: data.status === 'CHECKED' ? 'originality.checked' : 'originality.check_failed',
          entityType: 'RecommendationReview',
          entityId: s.review.id,
          metadata: {
            websiteId: s.opp.websiteId,
            opportunityId: s.opp.id,
            recommendationId: s.review.id,
            checkId: created.id,
            changeType: change.changeType,
            textHash: data.textHash,
            textLength: normalized.length, // never the text itself
            assessment: data.assessment ?? null,
            matchCount: Array.isArray(data.matches) ? data.matches.length : 0,
            checker: `${c.name}/${c.version}`,
            errorCode: data.errorCode ?? null,
          },
        },
        tx,
      );
      return created;
    });
    return checkView(row, cfg);
  },

  /** A stored CHECKED result for exactly this text, field, page version and checker, still within its TTL. */
  async reusable(tenant: TenantContext, s: CheckSubject, change: CheckChange, cfg = originalityConfig()) {
    const c = checker(cfg);
    if (!c) return null;
    const target = originalityTarget(change.changeType, change.targetSection, s.values);
    if (!target) return null;
    const normalized = change.changeType === 'SECTION_CONTENT' ? change.text.trim() : change.text.replace(/\s+/g, ' ').trim();
    const row = await prisma.originalityCheck.findFirst({
      where: {
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        recommendationReviewId: s.review.id,
        pageVersionId: s.version.id,
        changeType: change.changeType,
        targetSection: target.sectionKey,
        textHash: textHash(normalized),
        checker: c.name,
        checkerVersion: c.version,
        status: 'CHECKED',
        createdAt: { gt: new Date(Date.now() - cfg.resultTtlMs) },
      },
      orderBy: { createdAt: 'desc' },
    });
    return row ? checkView(row, cfg) : null;
  },

  /**
   * Approval gate, always on the final text being approved (AI draft or human edit). Reuses a fresh result for
   * the identical text, otherwise checks now. Applies the configured policy to significant matches; a failed
   * check is never treated as "no matches".
   */
  async enforce(tenant: TenantContext, s: CheckSubject, change: CheckChange, acknowledgedCheckId?: string | null, cfg = originalityConfig()): Promise<OriginalityDecision> {
    if (cfg.policy === 'off' || !checker(cfg) || !originalityTarget(change.changeType, change.targetSection, s.values)) {
      return { status: 'NOT_CHECKED', check: null, acknowledged: false };
    }
    const check = (await originalityService.reusable(tenant, s, change, cfg)) ?? (await originalityService.run(tenant, s, change, cfg));
    if (check.status === 'CHECK_FAILED') {
      if (cfg.requireCheck) throw new AppError('ORIGINALITY_CHECK_FAILED', 'The originality check failed for this text. Run the check again before approving.', { originality: check });
      return { status: 'CHECK_FAILED', check, acknowledged: false };
    }
    if (check.assessment !== 'SIGNIFICANT_MATCHES' || cfg.policy === 'warn') return { status: 'CHECKED', check, acknowledged: false };
    if (cfg.policy === 'block') {
      throw new AppError('ORIGINALITY_BLOCKED', 'This text closely matches other pages in this project. Edit it before approving.', { originality: check });
    }
    if (acknowledgedCheckId !== check.id) {
      throw new AppError('ORIGINALITY_ACK_REQUIRED', 'This text closely matches other pages in this project. Review the matches and acknowledge them, or edit the text.', { originality: check });
    }
    return { status: 'CHECKED', check, acknowledged: true };
  },

  /** Recent checks per recommendation, newest first, for the review payload. Tenant-scoped. */
  async recentByReview(tenant: TenantContext, reviewIds: string[], perReview = 5) {
    if (!reviewIds.length) return new Map<string, CheckView[]>();
    const rows = await prisma.originalityCheck.findMany({
      where: { organizationId: tenant.organizationId, projectId: tenant.projectId, recommendationReviewId: { in: reviewIds } },
      orderBy: { createdAt: 'desc' },
      take: reviewIds.length * perReview * 4,
    });
    const cfg = originalityConfig();
    const out = new Map<string, CheckView[]>();
    for (const r of rows) {
      const list = out.get(r.recommendationReviewId) ?? [];
      if (list.length < perReview) list.push(checkView(r, cfg));
      out.set(r.recommendationReviewId, list);
    }
    return out;
  },
};
