"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useLogout, useMe } from "@/hooks/use-auth";
import { useCurrentProject } from "@/hooks/use-projects";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/optimization/opportunities", label: "Opportunities", soon: true },
  { href: "/optimization/history", label: "History", soon: true },
  { href: "/settings/gsc", label: "Search Console", soon: true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const logout = useLogout();
  const { current, projects, select } = useCurrentProject();

  useEffect(() => {
    if (me.isError) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.isError, pathname, router]);

  if (!me.data) return <div className="p-8 text-sm text-zinc-500">Loading…</div>;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-zinc-200 bg-white p-4 md:block">
        <p className="mb-6 px-2 text-sm font-semibold">Blog Optimizer</p>
        <nav className="space-y-1">
          {NAV.map((item) =>
            item.soon ? (
              <span key={item.href} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-zinc-400">
                {item.label} <span className="text-[10px] uppercase">soon</span>
              </span>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-md px-2 py-1.5 text-sm ${pathname.startsWith(item.href) ? "bg-zinc-100 font-medium" : "text-zinc-600 hover:bg-zinc-50"}`}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-zinc-200 bg-white px-4 py-3 sm:px-6">
          {projects && projects.length > 0 ? (
            <select
              aria-label="Project"
              className="max-w-[60vw] rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              value={current?.id}
              onChange={(e) => select(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-zinc-500 sm:inline">{me.data.user.email}</span>
            <button
              className="text-zinc-600 hover:text-zinc-900"
              onClick={() => logout.mutate(undefined, { onSettled: () => router.replace("/login") })}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
