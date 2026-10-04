"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import type { ProjectSummary, Website } from "@/lib/types";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ items: ProjectSummary[] }>("/api/projects").then((r) => r.items),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) => api<ProjectSummary>("/api/projects", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useWebsites(projectId: string | undefined) {
  return useQuery({
    queryKey: ["projects", projectId, "websites"],
    queryFn: () => api<{ items: Website[] }>(`/api/projects/${projectId}/websites`).then((r) => r.items),
    enabled: Boolean(projectId),
  });
}

export function useCreateWebsite(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { baseUrl: string; blogPathPrefix?: string; updateEndpointUrl?: string; updateSecret?: string }) =>
      api<Website>(`/api/projects/${projectId}/websites`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects", projectId, "websites"] }),
  });
}

// Selected project is a per-browser convenience; the server re-authorizes every request.
const KEY = "currentProjectId";
const listeners = new Set<() => void>();
const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export function useCurrentProject() {
  const { data: projects } = useProjects();
  const stored = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    read,
    () => null,
  );
  const current = projects?.find((p) => p.id === stored) ?? projects?.[0];
  const select = useCallback((id: string) => {
    try {
      localStorage.setItem(KEY, id);
    } catch {}
    listeners.forEach((l) => l());
  }, []);
  return { current, projects, select };
}
