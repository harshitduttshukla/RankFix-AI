"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Me, User } from "@/lib/types";

export const meKey = ["me"] as const;

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: () => api<Me>("/api/auth/me"), retry: false });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api<{ user: User }>("/api/auth/login", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string; name?: string }) =>
      api<{ user: User }>("/api/auth/register", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => qc.clear(),
  });
}
