"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AIRun, ChangeType, OpportunityDetail, OriginalityCheck, RejectionReason, ReviewPayload } from "@/lib/types";

const base = (projectId: string, id: string) => `/api/projects/${projectId}/optimization/opportunities/${id}`;
const key = (projectId: string, id: string) => ["projects", projectId, "opportunities", "review", id] as const;

export function useReview(projectId: string | undefined, id: string) {
  return useQuery({
    queryKey: key(projectId ?? "", id),
    queryFn: () => api<ReviewPayload>(`${base(projectId!, id)}/review`),
    enabled: Boolean(projectId),
    // Poll only while the AI run is in flight.
    // Poll only while the AI run or an apply verification is in flight.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d?.analysisState === "QUEUED" || d?.analysisState === "RUNNING") return 3000;
      return d?.recommendations.some((r) => r.proposals.some((p) => p.apply?.run?.status === "APPLYING")) ? 3000 : false;
    },
  });
}

export interface ProposalInput {
  proposedValue: string;
  changeType?: ChangeType;
  targetSection?: string | null;
  acknowledgeOriginalityCheckId?: string;
}

type RecVars = { recId: string };

/** All review mutations; each refreshes the review (and the opportunity list, whose statuses change). */
export function useReviewActions(projectId: string, id: string) {
  const qc = useQueryClient();
  const b = base(projectId, id);
  const onSuccess = (data: unknown) => {
    if (data && typeof data === "object" && "analysisState" in data) qc.setQueryData(key(projectId, id), data);
    return qc.invalidateQueries({ queryKey: ["projects", projectId, "opportunities"] });
  };
  const post = <T,>(path: string, body?: unknown) => api<T>(`${b}${path}`, { method: "POST", body });

  return {
    analyze: useMutation({ mutationFn: () => post<AIRun>("/analyze"), onSuccess }),
    reanalyze: useMutation({ mutationFn: () => post<AIRun>("/reanalyze"), onSuccess }),
    edit: useMutation({
      mutationFn: ({ recId, ...body }: RecVars & { recommendation?: string; rationale?: string; targetSection?: string | null }) =>
        api<ReviewPayload>(`${b}/recommendations/${recId}`, { method: "PATCH", body }),
      onSuccess,
    }),
    approve: useMutation({
      mutationFn: ({ recId, ...body }: RecVars & ProposalInput) => post<ReviewPayload>(`/recommendations/${recId}/approve`, body),
      onSuccess,
    }),
    reject: useMutation({
      mutationFn: ({ recId, ...body }: RecVars & { reason?: RejectionReason; note?: string }) => post<ReviewPayload>(`/recommendations/${recId}/reject`, body),
      onSuccess,
    }),
    checkOriginality: useMutation({
      mutationFn: ({ recId, ...body }: RecVars & { text: string; changeType?: ChangeType; targetSection?: string | null; draftId?: string | null }) =>
        post<OriginalityCheck>(`/recommendations/${recId}/originality`, body),
      onSuccess: () => qc.invalidateQueries({ queryKey: key(projectId, id) }),
    }),
    regenerateDraft: useMutation({
      mutationFn: ({ recId }: RecVars) => post<ReviewPayload>(`/recommendations/${recId}/draft`),
      onSuccess,
    }),
    newProposal: useMutation({
      mutationFn: ({ recId, ...body }: RecVars & ProposalInput) => post<ReviewPayload>(`/recommendations/${recId}/proposal`, body),
      onSuccess,
    }),
    approveProposal: useMutation({
      mutationFn: ({ proposalId, comment, acknowledgeOriginalityCheckId }: { proposalId: string; comment?: string; acknowledgeOriginalityCheckId?: string }) =>
        post<ReviewPayload>(`/proposals/${proposalId}/approve`, { comment, acknowledgeOriginalityCheckId }),
      onSuccess,
    }),
    rejectProposal: useMutation({
      mutationFn: ({ proposalId, reason }: { proposalId: string; reason?: string }) => post<ReviewPayload>(`/proposals/${proposalId}/reject`, { reason }),
      onSuccess,
    }),
    rejectOpportunity: useMutation({ mutationFn: (v: { reason?: string }) => post<OpportunityDetail>("/reject", v), onSuccess }),
    // Phase 7a: the customer applied the change themselves; RankFix AI recrawls the page to verify it.
    markApplied: useMutation({
      mutationFn: ({ proposalId }: { proposalId: string }) => post<{ queued: boolean; review: ReviewPayload }>(`/proposals/${proposalId}/mark-applied`),
      onSuccess: (data) => onSuccess(data.review),
    }),
    abandon: useMutation({ mutationFn: (v: { reason?: string }) => post<ReviewPayload>("/abandon", v), onSuccess }),
  };
}

export type ReviewActions = ReturnType<typeof useReviewActions>;
