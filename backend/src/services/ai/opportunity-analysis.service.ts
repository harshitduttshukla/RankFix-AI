import { UnrecoverableError } from 'bullmq';
import { enqueueAIAnalysis } from '../../queues/ai-analysis.queue.js';
import { aiAnalysisRepository } from '../../repositories/ai-analysis.repository.js';
import { auditRepository } from '../../repositories/audit.repository.js';
import { opportunityRepository, REFRESHABLE } from '../../repositories/opportunity.repository.js';
import type { TenantContext } from '../../types/tenant.js';
import { AppError, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { AIError } from './ai.errors.js';
import { checkAnalysis, checkRecommendations } from './ai.guardrails.js';
import { aiProvider } from './ai.provider.js';
import { buildAIContext, CONTEXT_VERSION } from './ai-context.builder.js';
import { ANALYSIS_PROMPT_VERSION } from './prompts/index.js';

/*
 * Phase 5: AI analysis of a detected opportunity, for human review. Reads stored data, calls the AIProvider,
 * validates, and stores the result. It never changes page content or the opportunity's lifecycle status.
 */

export const opportunityAnalysisService = {
  /** Queues an analysis (202). A run already queued/running for the opportunity is returned instead of a new one. */
  async request(tenant: TenantContext, opportunityId: string) {
    const opp = await opportunityRepository.find(tenant, opportunityId);
    if (!opp) throw notFound('Opportunity');
    if (!REFRESHABLE.includes(opp.status)) {
      throw new AppError('INVALID_STATE_TRANSITION', `Only open opportunities can be analyzed (status is ${opp.status})`);
    }

    let provider;
    try {
      provider = aiProvider();
    } catch (err) {
      if (err instanceof AIError && err.code === 'AI_NOT_CONFIGURED') throw new AppError('AI_NOT_CONFIGURED', 'AI analysis is not configured on this server');
      throw err;
    }

    const existing = await aiAnalysisRepository.findActiveRun(tenant, opp.id);
    if (existing) return { run: existing, created: false };

    const { run, created } = await aiAnalysisRepository.createRun(tenant, {
      websiteId: opp.websiteId,
      opportunityId: opp.id,
      requestedById: tenant.userId,
      provider: provider.name,
      model: provider.model,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      contextVersion: CONTEXT_VERSION,
    });
    if (created) {
      await enqueueAIAnalysis(run.id);
      await auditRepository.record({
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        actorUserId: tenant.userId,
        action: 'ai.analysis_requested',
        entityType: 'OptimizationOpportunity',
        entityId: opp.id,
        metadata: { runId: run.id, model: provider.model, promptVersion: ANALYSIS_PROMPT_VERSION },
      });
    }
    return { run, created };
  },

  /** Latest run (any status) and the latest successful analysis for the opportunity. */
  async get(tenant: TenantContext, opportunityId: string) {
    const opp = await opportunityRepository.find(tenant, opportunityId);
    if (!opp) throw notFound('Opportunity');
    const [latestRun, analysis] = await Promise.all([
      aiAnalysisRepository.latestRun(tenant, opp.id),
      aiAnalysisRepository.latestAnalysis(tenant, opp.id),
    ]);
    return {
      opportunityId: opp.id,
      latestRun,
      analysis: analysis && {
        id: analysis.id,
        runId: analysis.runId,
        pageVersionId: analysis.pageVersionId,
        provider: analysis.provider,
        model: analysis.model,
        promptVersion: analysis.promptVersion,
        contextVersion: analysis.contextVersion,
        createdAt: analysis.createdAt,
        ...(analysis.analysis as object),
        recommendations: analysis.recommendations,
      },
    };
  },
};

/**
 * Worker entry point. Transient provider failures are rethrown for BullMQ to retry; everything else
 * (invalid or ungrounded output, refusal, truncation, missing data) fails the run once, for good.
 */
export async function runAIAnalysis(runId: string, attempt = 1) {
  const run = await aiAnalysisRepository.findRun(runId);
  if (!run) throw new UnrecoverableError('AI analysis run no longer exists');
  const started = await aiAnalysisRepository.transitionRun(runId, ['QUEUED', 'RUNNING'], {
    status: 'RUNNING',
    attempts: attempt,
    startedAt: run.startedAt ?? new Date(),
  });
  if (!started.count) throw new UnrecoverableError(`AI analysis run is not runnable (${run.status})`);

  const scope = { organizationId: run.organizationId, projectId: run.projectId };
  let tokens = { input: 0, output: 0 };
  try {
    // Fresh context, built from the run's own tenant scope.
    const context = await buildAIContext(scope, run.opportunityId);
    if (!REFRESHABLE.includes(context.opportunity.status as (typeof REFRESHABLE)[number])) {
      throw new AIError('CONTEXT_UNAVAILABLE', `Opportunity is no longer open (${context.opportunity.status})`, false);
    }
    const provider = aiProvider();

    const analysis = await provider.analyzeOpportunity(context);
    tokens = add(tokens, analysis.usage);
    const analysisIssues = checkAnalysis(context, analysis.output);
    if (analysisIssues.length) throw new AIError('AI_OUTPUT_INVALID', `Analysis failed grounding checks: ${analysisIssues.slice(0, 3).join('; ')}`, false);

    const recs = await provider.generateRecommendation(context, analysis.output);
    tokens = add(tokens, recs.usage);
    const recIssues = checkRecommendations(context, recs.output);
    if (recIssues.length) throw new AIError('AI_OUTPUT_INVALID', `Recommendations failed grounding checks: ${recIssues.slice(0, 3).join('; ')}`, false);

    const saved = await aiAnalysisRepository.complete(run, {
      provider: provider.name,
      model: analysis.model,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      contextVersion: context.contextVersion,
      pageVersionId: context.page.content?.versionId ?? null,
      analysis: analysis.output,
      recommendations: recs.output,
      latencyMs: analysis.latencyMs + recs.latencyMs,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
    });
    await auditRepository.record({
      ...scope,
      actorUserId: run.requestedById,
      action: 'ai.analysis_completed',
      entityType: 'OptimizationOpportunity',
      entityId: run.opportunityId,
      metadata: { runId, analysisId: saved.id, model: analysis.model, inputTokens: tokens.input, outputTokens: tokens.output },
    });
    return { analysisId: saved.id };
  } catch (err) {
    const e = err instanceof AIError ? err : err instanceof AppError && err.code === 'NOT_FOUND' ? new AIError('CONTEXT_UNAVAILABLE', 'Opportunity or page no longer exists', false) : null;
    if (e?.usage) tokens = add(tokens, e.usage);
    if (e && !e.retryable) {
      await markAIAnalysisFailed(runId, e.code, e.message, tokens);
      throw new UnrecoverableError(e.message);
    }
    // Retryable (or unexpected) errors: keep RUNNING, record the error, let BullMQ decide.
    await aiAnalysisRepository.transitionRun(runId, ['RUNNING'], { errorCode: e?.code ?? 'UNEXPECTED', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    logger.warn({ runId, attempt, code: e?.code }, 'AI analysis attempt failed');
    throw err;
  }
}

export async function markAIAnalysisFailed(runId: string, code: string, message: string, tokens?: { input: number; output: number }) {
  await aiAnalysisRepository.transitionRun(runId, ['QUEUED', 'RUNNING'], {
    status: 'FAILED',
    completedAt: new Date(),
    errorCode: code,
    errorMessage: message.slice(0, 500),
    ...(tokens && (tokens.input || tokens.output) ? { inputTokens: tokens.input, outputTokens: tokens.output } : {}),
  });
}

const add = (t: { input: number; output: number }, u: { inputTokens: number | null; outputTokens: number | null }) => ({
  input: t.input + (u.inputTokens ?? 0),
  output: t.output + (u.outputTokens ?? 0),
});
