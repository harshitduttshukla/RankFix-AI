"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CrawlDetail, CrawlJob, PageDetail, PageRow, PageStatus, PageVersion, Website } from "@/lib/types";

const ACTIVE = new Set(["PENDING", "RUNNING"]);
const key = (websiteId: string) => ["websites", websiteId] as const;

export function useWebsite(websiteId: string) {
  return useQuery({ queryKey: [...key(websiteId), "info"], queryFn: () => api<Website>(`/api/websites/${websiteId}`) });
}

export function useCrawls(websiteId: string) {
  return useQuery({
    queryKey: [...key(websiteId), "crawls"],
    queryFn: () => api<{ items: CrawlJob[] }>(`/api/websites/${websiteId}/crawls`).then((r) => r.items),
    refetchInterval: (q) => (q.state.data?.some((c) => ACTIVE.has(c.status)) ? 2000 : false),
  });
}

export function useCrawlDetail(websiteId: string, crawlId: string | undefined, live: boolean) {
  return useQuery({
    queryKey: [...key(websiteId), "crawls", crawlId],
    queryFn: () => api<CrawlDetail>(`/api/websites/${websiteId}/crawls/${crawlId}`),
    enabled: Boolean(crawlId),
    refetchInterval: live ? 2000 : false,
  });
}

export function useStartCrawl(websiteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<CrawlJob>(`/api/websites/${websiteId}/crawl`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(websiteId) }),
  });
}

export function useCancelCrawl(websiteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (crawlId: string) => api<CrawlJob>(`/api/websites/${websiteId}/crawls/${crawlId}/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(websiteId) }),
  });
}

export function usePages(websiteId: string, f: { status?: PageStatus; q?: string; cursor?: string }) {
  const params = new URLSearchParams();
  if (f.status) params.set("status", f.status);
  if (f.q) params.set("q", f.q);
  if (f.cursor) params.set("cursor", f.cursor);
  return useQuery({
    queryKey: [...key(websiteId), "pages", f],
    queryFn: () =>
      api<{ items: PageRow[]; nextCursor: string | null; counts: Partial<Record<PageStatus, number>> }>(
        `/api/websites/${websiteId}/pages?${params.toString()}`,
      ),
  });
}

export function usePageDetail(websiteId: string, pageId: string) {
  return useQuery({ queryKey: [...key(websiteId), "page", pageId], queryFn: () => api<PageDetail>(`/api/websites/${websiteId}/pages/${pageId}`) });
}

export function usePageVersions(websiteId: string, pageId: string) {
  return useQuery({
    queryKey: [...key(websiteId), "page", pageId, "versions"],
    queryFn: () => api<{ items: PageVersion[] }>(`/api/websites/${websiteId}/pages/${pageId}/versions`).then((r) => r.items),
  });
}
