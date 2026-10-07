"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useLogout, useMe } from "@/hooks/use-auth";
import { useCurrentProject } from "@/hooks/use-projects";
import { selectClass } from "./ui";

const NAV_GROUPS = [
  { label: "Overview", items: [{ href: "/dashboard", label: "Dashboard" }] },
  {
    label: "Optimize",
    items: [
      { href: "/optimization/opportunities", label: "Opportunities" },
      { href: "/optimization/history", label: "History", soon: true },
    ],
  },
  { label: "Settings", items: [{ href: "/settings/gsc", label: "Search Console" }] },
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

  if (!me.data) return <div className="p-8 text-[13px] text-ink3">Loading…</div>;

  const projectSelect =
    projects && projects.length > 0 ? (
      <select aria-label="Project" className={`w-full ${selectClass}`} value={current?.id} onChange={(e) => select(e.target.value)}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[238px] shrink-0 overflow-y-auto border-r border-line bg-rail md:block">
        <div className="border-b border-line2 px-[17px] pb-[13px] pt-[17px]">
          <div className="flex items-center gap-2">
            <span className="h-[9px] w-[9px] rounded-full bg-teal" />
            <span className="font-serif text-[15px] font-medium">Blog Optimizer</span>
          </div>
          <small className="mt-[3px] block text-[11.5px] text-ink3">Existing pages · GSC evidence · human approval</small>
        </div>
        {projectSelect && <div className="border-b border-line2 px-[17px] py-[11px]">{projectSelect}</div>}
        <nav className="px-[9px] pb-[30px] pt-[10px]">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mt-[13px] first:mt-0">
              <span className="block px-2 pb-[5px] text-[11px] text-ink3">{group.label}</span>
              {group.items.map((item) =>
                "soon" in item && item.soon ? (
                  <span key={item.href} className="flex items-center gap-[9px] rounded-[5px] px-2 py-[7px] text-[13.3px] text-ink3">
                    {item.label}
                    <span className="ml-auto rounded-[9px] border border-line px-[5px] text-[10.5px] text-ink3">soon</span>
                  </span>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                    className={`flex items-center gap-[9px] rounded-[5px] px-2 py-[7px] text-[13.3px] no-underline ${
                      pathname.startsWith(item.href) ? "bg-active font-medium text-ink" : "text-ink2 hover:bg-hover hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                ),
              )}
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-card px-4 py-2.5 sm:px-7">
          <div className="min-w-0 flex-1 md:hidden">{projectSelect}</div>
          <div className="ml-auto flex items-center gap-3 text-[13px]">
            <span className="hidden text-ink2 sm:inline">{me.data.user.email}</span>
            <button
              className="cursor-pointer text-ink2 hover:text-ink"
              onClick={() => logout.mutate(undefined, { onSettled: () => router.replace("/login") })}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="w-full max-w-[1280px] flex-1 px-4 pb-[70px] pt-6 sm:px-7">{children}</main>
      </div>
    </div>
  );
}
