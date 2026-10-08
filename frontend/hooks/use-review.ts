"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AIRun, ChangeType, OpportunityDetail, RejectionReason, ReviewPayload } from "@/lib/types";

const base = (projectId: string, id: string) => `/api/projects/${projectId}/optimization/opportunities/${id}`;
const key = (projectId: string, id: string) => ["projects", projectId, "opportunities", "review", id] as const;

export function useReview(projectId: string | undefined, id: string) {
  return useQuery({
    queryKey: key(projectId ?? "", id),
    queryFn: () => api<ReviewPayload>(`${base(projectId!, id)}/review`),
    enabled: Boolean(projectId),
    // Poll only while the AI run is in flight.
    refetchInterval: (q) => (q.state.data?.analysisState === "QUEUED" || q.state.data?.analysisState === "RUNNING" ? 3000 : false),
  });
}

export interface ProposalInput {
  proposedValue: string;
  changeType?: ChangeType;
  targetSection?: string | null;
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
    newProposal: useMutation({
      mutationFn: ({ recId, ...body }: RecVars & ProposalInput) => post<ReviewPayload>(`/recommendations/${recId}/proposal`, body),
      onSuccess,
    }),
    approveProposal: useMutation({
      mutationFn: ({ proposalId, comment }: { proposalId: string; comment?: string }) => post<ReviewPayload>(`/proposals/${proposalId}/approve`, { comment }),
      onSuccess,
    }),
    rejectProposal: useMutation({
      mutationFn: ({ proposalId, reason }: { proposalId: string; reason?: string }) => post<ReviewPayload>(`/proposals/${proposalId}/reject`, { reason }),
      onSuccess,
    }),
    rejectOpportunity: useMutation({ mutationFn: (v: { reason?: string }) => post<OpportunityDetail>("/reject", v), onSuccess }),
  };
}

export type ReviewActions = ReturnType<typeof useReviewActions>;
