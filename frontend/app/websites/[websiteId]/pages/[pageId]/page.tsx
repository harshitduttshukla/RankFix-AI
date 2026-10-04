"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { PageStatusChip, pathOf } from "@/components/crawl-status";
import { Card, Chip, ErrorText } from "@/components/ui";
import { usePageDetail, usePageVersions } from "@/hooks/use-crawl";
import { fmtDateTime, fmtInt } from "@/lib/format";
import type { ContentBlock, PageDetail } from "@/lib/types";

type Version = NonNullable<PageDetail["currentVersion"]>;

export default function PageDetailPage() {
  const { websiteId, pageId } = useParams<{ websiteId: string; pageId: string }>();
  const page = usePageDetail(websiteId, pageId);
  const versions = usePageVersions(websiteId, pageId);
  const p = page.data;
  const v = p?.currentVersion;

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1.5 text-[11.5px] text-ink3">
          <Link href="/dashboard" className="text-ink3 no-underline hover:text-ink">Dashboard</Link> /{" "}
          <Link href={`/websites/${websiteId}`} className="text-ink3 no-underline hover:text-ink">Website</Link> / Page
        </p>
        <h1>{v?.title ?? (p ? "(no title)" : "…")}</h1>
        {p && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ink2">
            <a href={p.url} target="_blank" rel="noreferrer noopener" className="font-mono text-[12.5px]">{p.url}</a>
            <PageStatusChip status={p.status} />
            {p.noindex && <Chip tone="coral">noindex</Chip>}
          </p>
        )}
      </div>
      <ErrorText error={page.error} />
      {p && !v && <p className="text-[13px] text-ink2">This page has no stored content yet.</p>}
      {p && v && (
        <>
          <div className="grid gap-[13px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <Metadata page={p} v={v} />
            <Outline v={v} />
          </div>
          <Sections v={v} />
          <Links v={v} />
          <Images v={v} />
          <StructuredData v={v} />
          <Card title="Versions">
            <ul className="divide-y divide-line2 text-[13px]">
              {versions.data?.map((ver) => (
                <li key={ver.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-mono">v{ver.versionNo}</span>
                  <span className="text-ink2">{fmtDateTime(ver.createdAt)}</span>
                  <span className="text-ink2">{ver.source.toLowerCase()} · {ver.extractionMethod === "PLAYWRIGHT" ? "browser render" : "HTML"} · {fmtInt(ver.wordCount)} words</span>
                  <span className="ml-auto font-mono text-[11px] text-ink3" title={ver.contentHash}>{ver.contentHash.slice(0, 12)}</span>
                  {ver.id === v.id && <Chip tone="teal">current</Chip>}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink3">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children ?? <span className="text-coral">missing</span>}</dd>
    </>
  );
}

function Metadata({ page, v }: { page: PageDetail; v: Version }) {
  // Compare like the backend normalizes URLs: a trailing slash alone is not a different canonical.
  const norm = (u: string) => u.replace(/#.*$/, "").replace(/(?<=[^/])\/+(?=$|\?)/, "").toLowerCase();
  const canonicalDiffers = v.canonicalUrl && norm(v.canonicalUrl) !== norm(page.url);
  return (
    <Card title="Metadata">
      <dl className="grid grid-cols-[132px_1fr] gap-x-3.5 gap-y-1.5 text-[13px]">
        <Row label="Title">{v.title && <>{v.title} <span className="font-mono text-[11px] text-ink3">({v.title.length})</span></>}</Row>
        <Row label="Meta description">{v.metaDescription && <>{v.metaDescription} <span className="font-mono text-[11px] text-ink3">({v.metaDescription.length})</span></>}</Row>
        <Row label="Canonical">
          {v.canonicalUrl && (
            <span className="font-mono text-[12px]">
              {pathOf(v.canonicalUrl)} {canonicalDiffers && <Chip tone="coral">differs from URL</Chip>}
            </span>
          )}
        </Row>
        <Row label="H1">{v.h1}</Row>
        <Row label="Language">{v.language}</Row>
        <Row label="Robots">{v.robotsMeta ?? <span className="text-ink3">not set</span>}</Row>
        <Row label="OpenGraph">{Object.keys(v.seoMeta.og).length ? Object.entries(v.seoMeta.og).map(([k, val]) => <div key={k} className="truncate"><span className="text-ink3">og:{k}</span> {val}</div>) : null}</Row>
        <Row label="Twitter">{Object.keys(v.seoMeta.twitter).length ? Object.entries(v.seoMeta.twitter).map(([k, val]) => <div key={k} className="truncate"><span className="text-ink3">twitter:{k}</span> {val}</div>) : <span className="text-ink3">not set</span>}</Row>
        <Row label="Words">{<span className="font-mono">{fmtInt(v.wordCount)}</span>}</Row>
        <Row label="Extraction">{`${v.extractionMethod === "PLAYWRIGHT" ? "Browser render (Playwright)" : "HTML (Cheerio)"} · crawler ${v.crawlerVersion ?? "?"}`}</Row>
        <Row label="Last crawled">{fmtDateTime(page.lastCrawledAt)}</Row>
        <Row label="Version">{<span className="font-mono">v{v.versionNo}</span>}</Row>
      </dl>
    </Card>
  );
}

function Outline({ v }: { v: Version }) {
  return (
    <Card title="Heading structure">
      {v.headings.length ? (
        <ol className="space-y-1 text-[13px]">
          {v.headings.map((h) => (
            <li key={h.order} style={{ paddingLeft: `${(h.level - 1) * 14}px` }} className="flex gap-2">
              <span className="w-6 shrink-0 font-mono text-[11px] text-ink3">H{h.level}</span>
              <span>{h.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[13px] text-coral">No headings found.</p>
      )}
    </Card>
  );
}

function BlockView({ b }: { b: ContentBlock }) {
  if (b.type === "ul" || b.type === "ol") {
    const L = b.type;
    return <L className={`ml-5 ${b.type === "ul" ? "list-disc" : "list-decimal"}`}>{b.items?.map((i, n) => <li key={n}>{i}</li>)}</L>;
  }
  if (b.type === "table") return <div className="rounded border border-line2 bg-rail px-2 py-1 font-mono text-[12px]">{b.items?.map((r, n) => <div key={n}>{r}</div>)}</div>;
  if (b.type === "img" || (b.type === "figure" && b.src)) {
    return (
      <p className="text-[12px] text-ink2">
        <span className="text-ink3">[image]</span> <span className="font-mono">{b.src ? pathOf(b.src) : ""}</span>{" "}
        {b.alt === null || b.alt === undefined ? <span className="text-coral">no alt</span> : b.alt ? `alt: "${b.alt}"` : <span className="text-ink3">decorative</span>}
        {b.text && ` · ${b.text}`}
      </p>
    );
  }
  if (b.type === "blockquote") return <blockquote className="border-l-2 border-line pl-3 text-ink2">{b.text}</blockquote>;
  if (b.type === "pre") return <pre className="overflow-x-auto rounded bg-[#14191C] p-3 font-mono text-[12px] text-[#D8E0DE]">{b.text}</pre>;
  return <p>{b.text}</p>;
}

function Sections({ v }: { v: Version }) {
  const [open, setOpen] = useState<Set<number>>(new Set([0, 1]));
  const toggle = (n: number) => setOpen((s) => (s.has(n) ? (s.delete(n), new Set(s)) : new Set(s.add(n))));
  return (
    <Card title={`Content sections (${v.pageSections.length})`}>
      <div className="space-y-2">
        {v.pageSections.map((s) => (
          <div key={s.sectionKey} className="rounded-lg border border-line2">
            <button className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left" onClick={() => toggle(s.order)} aria-expanded={open.has(s.order)}>
              <span className="w-7 shrink-0 font-mono text-[11px] text-ink3">{s.level ? `H${s.level}` : "—"}</span>
              <span className={`flex-1 ${s.heading ? "font-medium" : "italic text-ink2"}`}>{s.heading ?? "Introduction"}</span>
              <span className="font-mono text-[11px] text-ink3">{s.wordCount} words</span>
            </button>
            {open.has(s.order) && (
              <div className="space-y-2 border-t border-line2 px-3 py-3 text-[13px] leading-relaxed">
                {s.blocks.length ? s.blocks.map((b, n) => <BlockView key={n} b={b} />) : <p className="text-ink3">No content under this heading.</p>}
                <p className="font-mono text-[10.5px] text-ink3">{s.sectionKey}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function LinkList({ title, links }: { title: string; links: Version["links"] }) {
  return (
    <div>
      <h3 className="mb-2 text-[13px]">{title} <span className="font-mono text-[11px] text-ink3">({links.length})</span></h3>
      {links.length ? (
        <ul className="max-h-72 space-y-1 overflow-auto text-[12.5px]">
          {links.map((l, n) => (
            <li key={n} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate" title={l.targetUrl}>
                {l.anchorText || <span className="text-coral">empty anchor</span>} <span className="font-mono text-[11px] text-ink3">→ {l.isInternal ? pathOf(l.targetUrl) : l.targetUrl}</span>
              </span>
              {!l.inContent && <span className="text-[11px] text-ink3">nav/footer</span>}
              {l.nofollow && <span className="text-[11px] text-ink3">nofollow</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink3">None</p>
      )}
    </div>
  );
}

function Links({ v }: { v: Version }) {
  return (
    <Card title="Links">
      <div className="grid gap-5 md:grid-cols-2">
        <LinkList title="Internal" links={v.links.filter((l) => l.isInternal)} />
        <LinkList title="External" links={v.links.filter((l) => !l.isInternal)} />
      </div>
    </Card>
  );
}

function Images({ v }: { v: Version }) {
  const content = v.images.filter((i) => i.inContent);
  const missingAlt = content.filter((i) => i.alt === null).length;
  return (
    <Card title={`Images in content (${content.length})`} action={missingAlt ? <Chip tone="coral">{missingAlt} missing alt</Chip> : undefined}>
      {content.length ? (
        <ul className="space-y-1 text-[12.5px]">
          {content.map((i) => (
            <li key={i.src} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={i.src}>{pathOf(i.src)}</span>
              <span className={i.alt === null ? "text-coral" : i.alt === "" ? "text-ink3" : ""}>{i.alt === null ? "no alt" : i.alt === "" ? "decorative" : i.alt}</span>
              {i.width && i.height && <span className="font-mono text-[11px] text-ink3">{i.width}×{i.height}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink3">No images in the main content.</p>
      )}
    </Card>
  );
}

function StructuredData({ v }: { v: Version }) {
  return (
    <Card title="Structured data (JSON-LD)" action={v.invalidJsonLd ? <Chip tone="coral">{v.invalidJsonLd} invalid block{v.invalidJsonLd > 1 ? "s" : ""}</Chip> : undefined}>
      {v.structuredData.length ? (
        <div className="space-y-2">
          {v.structuredData.map((d, n) => (
            <details key={n} className="rounded-lg border border-line2 px-3 py-2">
              <summary className="cursor-pointer text-[13px]">{d.types.length ? d.types.join(", ") : "(no @type)"}</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-[#14191C] p-3 font-mono text-[11.5px] text-[#D8E0DE]">{JSON.stringify(d.data, null, 2)}</pre>
            </details>
          ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-ink3">No JSON-LD on this page.</p>
      )}
    </Card>
  );
}
