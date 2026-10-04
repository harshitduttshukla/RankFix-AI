"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field } from "@/components/ui";
import { useCreateProject, useCreateWebsite, useCurrentProject, useWebsites } from "@/hooks/use-projects";
import type { ProjectSummary } from "@/lib/types";

export default function DashboardPage() {
  const { current, projects, select } = useCurrentProject();

  if (!projects) return <p className="text-[13px] text-ink3">Loading…</p>;
  if (!current) return <CreateProject onCreated={select} first />;

  return (
    <div className="space-y-6">
      <div>
        <h1>{current.name}</h1>
        <p className="mt-1 text-[13.4px] text-ink2">{current.organizationName} · {current.role.toLowerCase()}</p>
      </div>
      <Websites project={current} />
      <CreateProject onCreated={select} />
    </div>
  );
}

function CreateProject({ onCreated, first = false }: { onCreated: (id: string) => void; first?: boolean }) {
  const create = useCreateProject();
  const [name, setName] = useState("");
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate({ name }, { onSuccess: (p) => (setName(""), onCreated(p.id)) });
  }
  return (
    <Card title={first ? "Create your first project" : "New project"}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Project name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" disabled={create.isPending}>Create project</Button>
      </form>
      <div className="mt-3"><ErrorText error={create.error} /></div>
    </Card>
  );
}

function Websites({ project }: { project: ProjectSummary }) {
  const { data: websites, isLoading } = useWebsites(project.id);
  const canEdit = project.role === "OWNER" || project.role === "ADMIN";
  const [adding, setAdding] = useState(false);

  return (
    <Card
      title="Websites"
      action={canEdit && !adding ? <Button variant="secondary" onClick={() => setAdding(true)}>Add website</Button> : null}
    >
      {adding && <AddWebsite projectId={project.id} onDone={() => setAdding(false)} />}
      {isLoading ? (
        <p className="text-[13px] text-ink3">Loading…</p>
      ) : websites?.length ? (
        <ul className="divide-y divide-line2">
          {websites.map((w) => (
            <li key={w.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-mono text-[12.5px] font-medium">{w.baseUrl}</p>
                <p className="text-[11.5px] text-ink3">
                  Blog path: {w.blogPathPrefix ?? "entire site"} · Update API: {w.hasUpdateSecret ? "configured" : "not configured"}
                </p>
              </div>
              <span className="text-[11.5px] text-ink3">
                {w.lastCrawledAt ? `Crawled ${new Date(w.lastCrawledAt).toLocaleDateString()}` : "Not crawled yet"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !adding && <p className="text-[13px] text-ink3">No websites yet. Add the site whose existing blog you want to optimize.</p>
      )}
    </Card>
  );
}

function AddWebsite({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const create = useCreateWebsite(projectId);
  const [form, setForm] = useState({ baseUrl: "", blogPathPrefix: "", updateEndpointUrl: "", updateSecret: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        baseUrl: form.baseUrl,
        blogPathPrefix: form.blogPathPrefix || undefined,
        updateEndpointUrl: form.updateEndpointUrl || undefined,
        updateSecret: form.updateSecret || undefined,
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} className="mb-5 space-y-3 rounded-md border border-line2 bg-rail p-4">
      <Field label="Website URL" placeholder="https://example.com" required value={form.baseUrl} onChange={set("baseUrl")} />
      <Field label="Blog path prefix" placeholder="/blog/" hint="Optional. Limits page discovery to this path." value={form.blogPathPrefix} onChange={set("blogPathPrefix")} />
      <Field label="Site Update API endpoint" placeholder="https://example.com/_gsc-optimizer" hint="Optional now; needed before applying changes." value={form.updateEndpointUrl} onChange={set("updateEndpointUrl")} />
      <Field label="Site Update API secret" type="password" hint="At least 32 characters. Stored encrypted; never shown again." value={form.updateSecret} onChange={set("updateSecret")} autoComplete="off" />
      <ErrorText error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>Save website</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
