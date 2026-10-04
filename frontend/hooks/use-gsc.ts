"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { GscAvailableProperty, GscStatus, SitePerformance } from "@/lib/types";

const statusKey = (projectId: string) => ["projects", projectId, "gsc"] as const;

export function useGscStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: statusKey(projectId ?? ""),
    queryFn: () => api<GscStatus>(`/api/projects/${projectId}/gsc`),
    enabled: Boolean(projectId),
    // Poll while a sync is in flight.
    refetchInterval: (q) =>
      q.state.data?.properties.some((p) => p.syncStatus === "QUEUED" || p.syncStatus === "RUNNING") ? 3000 : false,
  });
}

export function useGscProperties(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...statusKey(projectId), "available"],
    queryFn: () => api<{ properties: GscAvailableProperty[] }>(`/api/projects/${projectId}/gsc/properties`).then((r) => r.properties),
    enabled,
  });
}

export function useConnectGsc(projectId: string) {
  return useMutation({
    mutationFn: () => api<{ authUrl: string }>(`/api/projects/${projectId}/gsc/connect`, { method: "POST" }),
    onSuccess: ({ authUrl }) => {
      window.location.assign(authUrl);
    },
  });
}

export function useSelectProperty(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { websiteId: string; siteUrl: string }) =>
      api(`/api/projects/${projectId}/gsc/select-property`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: statusKey(projectId) }),
  });
}

export function useSyncGsc(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { websiteId?: string; days?: number }) =>
      api(`/api/projects/${projectId}/gsc/sync`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: statusKey(projectId) }),
  });
}

export function useDisconnectGsc(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/projects/${projectId}/gsc`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects", projectId] }),
  });
}

export function useSitePerformance(projectId: string, websiteId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["projects", projectId, "performance", websiteId],
    queryFn: () => api<SitePerformance>(`/api/projects/${projectId}/gsc/performance?websiteId=${websiteId}`),
    enabled,
  });
}
