import { Prisma, type AIRunStatus } from '@prisma/client';
import { prisma } from '../config/database.js';
import type { TenantContext } from '../types/tenant.js';

type Scope = Pick<TenantContext, 'organizationId' | 'projectId'>;
const t = (scope: Scope) => ({ organizationId: scope.organizationId, projectId: scope.projectId });
const json = (v: unknown) => v as Prisma.InputJsonValue;

export const ACTIVE_AI_RUN: AIRunStatus[] = ['QUEUED', 'RUNNING'];

export const runSelect = {
  id: true,
  opportunityId: true,
  provider: true,
  model: true,
  promptVersion: true,
  contextVersion: true,
  status: true,
  attempts: true,
  startedAt: true,
  completedAt: true,
  latencyMs: true,
  inputTokens: true,
  outputTokens: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
} as const;

export const aiAnalysisRepository = {
  findActiveRun(scope: Scope, opportunityId: string) {
    return prisma.aIAnalysisRun.findFirst({ where: { ...t(scope), opportunityId, status: { in: ACTIVE_AI_RUN } }, select: runSelect });
  },

  /**
   * Creates a QUEUED run, or returns the already-active one: the partial unique index allows only one
   * QUEUED/RUNNING run per opportunity, so concurrent duplicate requests collapse here.
   */
  async createRun(
    scope: Scope,
    data: { websiteId: string; opportunityId: string; requestedById: string; provider: string; model: string; promptVersion: string; contextVersion: string },
  ): Promise<{ run: Prisma.AIAnalysisRunGetPayload<{ select: typeof runSelect }>; created: boolean }> {
    try {
      return { run: await prisma.aIAnalysisRun.create({ data: { ...t(scope), ...data }, select: runSelect }), created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const active = await aiAnalysisRepository.findActiveRun(scope, data.opportunityId);
        if (active) return { run: active, created: false };
      }
      throw err;
    }
  },

  findRun(runId: string) {
    return prisma.aIAnalysisRun.findUnique({ where: { id: runId } });
  },

  transitionRun(runId: string, from: AIRunStatus[], data: Prisma.AIAnalysisRunUpdateManyMutationInput) {
    return prisma.aIAnalysisRun.updateMany({ where: { id: runId, status: { in: from } }, data });
  },

  latestRun(scope: Scope, opportunityId: string) {
    return prisma.aIAnalysisRun.findFirst({ where: { ...t(scope), opportunityId }, orderBy: { createdAt: 'desc' }, select: runSelect });
  },

  latestAnalysis(scope: Scope, opportunityId: string) {
    return prisma.opportunityAnalysis.findFirst({ where: { ...t(scope), opportunityId }, orderBy: { createdAt: 'desc' } });
  },

  /** Stores the validated analysis and completes the run atomically; a run that isn't RUNNING any more rolls back. */
  async complete(
    run: { id: string; organizationId: string; projectId: string; websiteId: string; opportunityId: string },
    data: {
      provider: string;
      model: string;
      promptVersion: string;
      contextVersion: string;
      pageVersionId: string | null;
      analysis: unknown;
      recommendations: unknown;
      evidenceSnapshot?: unknown;
      latencyMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
    },
  ) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.aIAnalysisRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          model: data.model,
          latencyMs: data.latencyMs,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (!count) throw new Error('AI analysis run is no longer running');
      return tx.opportunityAnalysis.create({
        data: {
          organizationId: run.organizationId,
          projectId: run.projectId,
          websiteId: run.websiteId,
          opportunityId: run.opportunityId,
          runId: run.id,
          pageVersionId: data.pageVersionId,
          provider: data.provider,
          model: data.model,
          promptVersion: data.promptVersion,
          contextVersion: data.contextVersion,
          analysis: json(data.analysis),
          recommendations: json(data.recommendations),
          ...(data.evidenceSnapshot ? { evidenceSnapshot: json(data.evidenceSnapshot) } : {}),
        },
      });
    });
  },

  failStaleRuns(cutoff: Date) {
    return prisma.aIAnalysisRun.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: cutoff } },
      data: { status: 'FAILED', errorCode: 'INTERRUPTED', errorMessage: 'Analysis was interrupted', completedAt: new Date() },
    });
  },
};
