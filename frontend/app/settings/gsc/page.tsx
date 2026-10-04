"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button, Card, ErrorText } from "@/components/ui";
import {
  useConnectGsc,
  useDisconnectGsc,
  useGscProperties,
  useGscStatus,
  useSelectProperty,
  useSitePerformance,
  useSyncGsc,
} from "@/hooks/use-gsc";
import { useCurrentProject, useWebsites } from "@/hooks/use-projects";
import { fmtDateTime, fmtInt, fmtPct, fmtPos } from "@/lib/format";
import type { GscPropertyMapping, ProjectSummary } from "@/lib/types";

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "You declined access in Google. Search Console was not connected.",
  invalid_state: "The connection link expired or was already used. Please try again.",
  session_mismatch: "You were signed in as a different user when Google redirected back. Please try again.",
  forbidden: "You need the Admin role on this project to connect Search Console.",
  scope_missing: "Google did not grant Search Console read access. Please allow it on the consent screen.",
  no_refresh_token: "Google did not return offline access. Please try again.",
  exchange_failed: "Google rejected the sign-in. Check the OAuth client settings and try again.",
};

export default function GscSettingsPage() {
  return (
    <Suspense>
      <GscSettings />
    </Suspense>
  );
}

function GscSettings() {
  const { current } = useCurrentProject();
  const params = useSearchParams();
  const error = params.get("error");

  if (!current) return <p className="text-sm text-zinc-500">Create a project on the dashboard first.</p>;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Search Console</h1>
      {params.get("status") === "connected" && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Google Search Console connected.</p>
      )}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{OAUTH_ERRORS[error] ?? "Connecting failed. Please try again."}</p>}
      <Connection project={current} />
    </div>
  );
}

const isAdmin = (p: ProjectSummary) => p.role === "OWNER" || p.role === "ADMIN";

function Connection({ project }: { project: ProjectSummary }) {
  const status = useGscStatus(project.id);
  const connect = useConnectGsc(project.id);
  const disconnect = useDisconnectGsc(project.id);

  if (!status.data) return <p className="text-sm text-zinc-500">Loading…</p>;
  const s = status.data;

  return (
    <>
      <Card
        title="Google account"
        action={
          s.connected && isAdmin(project) ? (
            <Button
              variant="secondary"
              disabled={disconnect.isPending}
              onClick={() => confirm("Disconnect Search Console? Synced data for this project will be deleted.") && disconnect.mutate()}
            >
              Disconnect
            </Button>
          ) : null
        }
      >
        {s.connected ? (
          <p className="text-sm">
            Connected as <span className="font-medium">{s.googleEmail}</span>. Read-only access to Search Console.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-600">
              {s.revoked
                ? "Google access was revoked or expired. Reconnect to keep syncing."
                : "Connect the Google account that has access to your Search Console property. We only request read-only access."}
            </p>
            {isAdmin(project) ? (
              <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                {s.revoked ? "Reconnect Google" : "Connect Google Search Console"}
              </Button>
            ) : (
              <p className="text-sm text-zinc-500">Ask a project admin to connect Search Console.</p>
            )}
            <ErrorText error={connect.error ?? disconnect.error} />
          </div>
        )}
      </Card>
      {s.connected && <PropertyMapping project={project} mappings={s.properties} />}
      {s.properties.map((m) => (
        <PropertySync key={m.id} project={project} mapping={m} />
      ))}
    </>
  );
}

function PropertyMapping({ project, mappings }: { project: ProjectSummary; mappings: GscPropertyMapping[] }) {
  const { data: websites } = useWebsites(project.id);
  const available = useGscProperties(project.id, isAdmin(project));
  const select = useSelectProperty(project.id);

  if (!isAdmin(project)) return null;
  if (!websites?.length) return <Card title="Properties"><p className="text-sm text-zinc-500">Add a website on the dashboard first.</p></Card>;

  return (
    <Card title="Map properties to websites">
      <ErrorText error={available.error ?? select.error} />
      <ul className="divide-y divide-zinc-100">
        {websites.map((w) => {
          const mapped = mappings.find((m) => m.websiteId === w.id);
          const options = available.data?.filter((p) => p.matchingWebsiteIds.includes(w.id)) ?? [];
          return (
            <li key={w.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="truncate text-sm font-medium">{w.baseUrl}</span>
              {available.isLoading ? (
                <span className="text-sm text-zinc-500">Loading properties…</span>
              ) : options.length ? (
                <select
                  aria-label={`Property for ${w.baseUrl}`}
                  className="max-w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                  value={mapped?.siteUrl ?? ""}
                  disabled={select.isPending}
                  onChange={(e) => e.target.value && select.mutate({ websiteId: w.id, siteUrl: e.target.value })}
                >
                  <option value="">Select a property…</option>
                  {options.map((o) => (
                    <option key={o.siteUrl} value={o.siteUrl}>
                      {o.siteUrl}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-zinc-500">No verified property in this Google account covers {w.hostname}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PropertySync({ project, mapping }: { project: ProjectSummary; mapping: GscPropertyMapping }) {
  const sync = useSyncGsc(project.id);
  const [days, setDays] = useState(90);
  const busy = mapping.syncStatus === "QUEUED" || mapping.syncStatus === "RUNNING";
  const perf = useSitePerformance(project.id, mapping.websiteId, Boolean(mapping.lastSyncedAt) && !busy);
  const canSync = project.role !== "VIEWER";

  return (
    <Card title={`${mapping.siteUrl} → ${mapping.website.baseUrl}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          <StatusBadge status={mapping.syncStatus} />
          <span className="ml-2 text-zinc-600">
            Last sync: {fmtDateTime(mapping.lastSyncedAt)}
            {mapping.lastSyncedDate && ` · data through ${mapping.lastSyncedDate}`}
          </span>
          {mapping.syncError && <p className="mt-1 text-red-700">{mapping.syncError}</p>}
        </div>
        {canSync && (
          <div className="flex items-center gap-2">
            {!mapping.lastSyncedAt && (
              <select aria-label="History to import" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={28}>28 days</option>
                <option value={90}>90 days</option>
                <option value={180}>6 months</option>
                <option value={480}>16 months</option>
              </select>
            )}
            <Button
              disabled={busy || sync.isPending}
              onClick={() => sync.mutate({ websiteId: mapping.websiteId, days: mapping.lastSyncedAt ? undefined : days })}
            >
              {busy ? "Syncing…" : mapping.lastSyncedAt ? "Sync now" : "Start first sync"}
            </Button>
          </div>
        )}
      </div>
      <ErrorText error={sync.error} />
      {perf.data && <PerformanceSummary data={perf.data} />}
    </Card>
  );
}

function StatusBadge({ status }: { status: GscPropertyMapping["syncStatus"] }) {
  const styles = {
    IDLE: "bg-zinc-100 text-zinc-700",
    QUEUED: "bg-amber-50 text-amber-800",
    RUNNING: "bg-blue-50 text-blue-800",
    FAILED: "bg-red-50 text-red-700",
  }[status];
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${styles}`}>{status === "IDLE" ? "Ready" : status.toLowerCase()}</span>;
}

function PerformanceSummary({ data }: { data: NonNullable<ReturnType<typeof useSitePerformance>["data"]> }) {
  const t = data.totals;
  return (
    <div className="mt-5 space-y-4">
      <p className="text-xs text-zinc-500">
        {data.window.start} to {data.window.end} (summed across pages)
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Clicks", fmtInt(t.clicks)],
          ["Impressions", fmtInt(t.impressions)],
          ["CTR", fmtPct(t.ctr)],
          ["Avg. position", fmtPos(t.position)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border border-zinc-200 p-3">
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {data.pages.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Top pages</th>
                <th className="py-2 pr-3 text-right font-medium">Clicks</th>
                <th className="py-2 pr-3 text-right font-medium">Impr.</th>
                <th className="py-2 pr-3 text-right font-medium">CTR</th>
                <th className="py-2 text-right font-medium">Pos.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 tabular-nums">
              {data.pages.slice(0, 10).map((p) => (
                <tr key={p.page}>
                  <td className="max-w-xs truncate py-2 pr-3" title={p.page}>{new URL(p.page).pathname}</td>
                  <td className="py-2 pr-3 text-right">{fmtInt(p.clicks)}</td>
                  <td className="py-2 pr-3 text-right">{fmtInt(p.impressions)}</td>
                  <td className="py-2 pr-3 text-right">{fmtPct(p.ctr)}</td>
                  <td className="py-2 text-right">{fmtPos(p.position)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
