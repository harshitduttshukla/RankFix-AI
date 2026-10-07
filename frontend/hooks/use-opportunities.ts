"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { DetectionRun, OpportunityDetail, OpportunityRow, OpportunityType } from "@/lib/types";

const key = (projectId: string) => ["projects", projectId, "opportunities"] as const;
const base = (projectId: string) => `/api/projects/${projectId}/optimization/opportunities`;
const ACTIVE_RUN = new Set(["QUEUED", "RUNNING"]);

export interface OpportunityFilters {
  status: "open" | "dismissed" | "all";
  type?: OpportunityType;
  offset: number;
}

export function useOpportunities(projectId: string | undefined, f: OpportunityFilters) {
  const params = new URLSearchParams({ status: f.status, offset: String(f.offset), limit: "50" });
  if (f.type) params.set("type", f.type);
  return useQuery({
    queryKey: [...key(projectId ?? ""), "list", f],
    queryFn: () =>
      api<{ items: OpportunityRow[]; total: number; latestRun: DetectionRun | null }>(`${base(projectId!)}?${params.toString()}`),
    enabled: Boolean(projectId),
    // Poll while a detection run is in flight.
    refetchInterval: (q) => (q.state.data?.latestRun && ACTIVE_RUN.has(q.state.data.latestRun.status) ? 2500 : false),
  });
}

export function useOpportunity(projectId: string | undefined, id: string) {
  return useQuery({
    queryKey: [...key(projectId ?? ""), "detail", id],
    queryFn: () => api<OpportunityDetail>(`${base(projectId!)}/${id}`),
    enabled: Boolean(projectId),
  });
}

export function useDetectOpportunities(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<DetectionRun>(`${base(projectId)}/detect`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  });
}

export function useDismissOpportunity(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => api<OpportunityDetail>(`${base(projectId)}/${id}/dismiss`, { method: "POST", body: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  });
}
