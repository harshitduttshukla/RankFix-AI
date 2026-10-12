import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { EarlyAccessForm } from "@/components/landing/early-access-form";
import { Wordmark } from "@/components/landing/logo";
import {
  AnalysisMock,
  DraftEditorMock,
  HeroPreview,
  OpportunityTableMock,
  OriginalityMock,
  ReviewMock,
  StepVisual,
} from "@/components/landing/mockups";
import { RevealOnScroll } from "@/components/landing/reveal";
import { NAV } from "@/components/landing/nav";
import { SiteHeader } from "@/components/landing/site-header";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"], display: "swap" });

const DESCRIPTION =
  "Find opportunities hiding in Google Search Console, understand what needs improvement, and generate evidence-based content drafts you can review before making changes.";

export const metadata: Metadata = {
  // Absolute URLs for social previews once the production domain is set; no canonical until it is confirmed.
  ...(process.env.NEXT_PUBLIC_SITE_URL ? { metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL) } : {}),
  title: "RankFix AI — Find SEO Opportunities. Fix What Matters.",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "RankFix AI",
    title: "RankFix AI — Find SEO Opportunities. Fix What Matters.",
    description: DESCRIPTION,
  },
  twitter: { card: "summary_large_image", title: "RankFix AI — Find SEO Opportunities. Fix What Matters.", description: DESCRIPTION },
};

const REPO = "https://github.com/harshitduttshukla/RankFix-AI";

// ───────────────────────── building blocks ─────────────────────────

function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1200px] px-5 sm:px-8 ${className}`}>{children}</div>;
}

function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[12.5px] font-semibold uppercase tracking-[0.14em] text-brand ${className}`}>{children}</p>;
}

function Heading({ children, className = "", as: Tag = "h2" }: { children: ReactNode; className?: string; as?: "h1" | "h2" | "h3" }) {
  return <Tag className={`font-display font-semibold tracking-[-0.035em] text-lp-ink ${className}`}>{children}</Tag>;
}

function PrimaryCta({ children = "Get Early Access", dark = false }: { children?: ReactNode; dark?: boolean }) {
  return (
    <a
      href="#early-access"
      className={`inline-flex h-12 items-center justify-center rounded-lg px-6 text-[15px] font-semibold no-underline transition-colors ${
        dark ? "bg-white text-lp-ink hover:bg-brand-soft" : "bg-brand text-white hover:bg-brand-dark"
      }`}
    >
      {children}
    </a>
  );
}

function SecondaryCta({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="group inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-lp-line bg-white px-6 text-[15px] font-semibold text-lp-ink no-underline transition-colors hover:border-lp-ink3">
      {children}
      <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
    </a>
  );
}

function Check({ className = "text-brand" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`mt-0.5 h-5 w-5 shrink-0 ${className}`} aria-hidden="true">
      <path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ───────────────────────── content ─────────────────────────

const PROBLEMS = [
  { title: "Opportunities go unnoticed", body: "Important pages can earn impressions without attracting enough clicks, and nothing flags them." },
  { title: "Data doesn’t explain the next action", body: "Search Console shows performance, but someone still has to decide what to improve, and why." },
  { title: "AI copy needs oversight", body: "Generic drafts can introduce unsupported claims or miss the search opportunity that actually matters." },
];

const STEPS = [
  { n: "01", title: "Connect", body: "Connect a Google Search Console property with read-only access and retrieve search performance data." },
  { n: "02", title: "Discover", body: "Identify existing pages with meaningful SEO opportunity signals, scored and ranked by their evidence." },
  { n: "03", title: "Understand and Draft", body: "Analyze page and query evidence, then generate a proposed content improvement that is validated before you see it." },
  { n: "04", title: "Review and Approve", body: "Edit, approve, or reject the proposed change before it can proceed to implementation." },
] as const;

const FLOW = ["Search Console", "Opportunity Detection", "AI Analysis", "Draft Generation", "Human Review", "Approved Change"];

const AUDIENCES = [
  { title: "SEO professionals", body: "Prioritize existing pages using performance evidence and reviewable recommendations, with the reasoning attached." },
  { title: "Content teams", body: "Turn search performance findings into specific content changes: the field, the current copy, and a proposed draft." },
  { title: "Website owners", body: "Understand which pages may need attention without manually interpreting every metric." },
];

const TRADITIONAL = [
  "Inspect Search Console manually.",
  "Decide what to optimize.",
  "Draft changes in separate tools.",
  "Review copy and evidence separately.",
  "Track changes manually.",
];
const RANKFIX = [
  "Surface existing-page opportunities.",
  "Explain the evidence behind each signal.",
  "Generate focused content drafts.",
  "Review and approve changes in one workflow.",
  "Build toward measurable optimization.",
];

const PRINCIPLES = [
  { title: "Evidence-based recommendations", body: "Each recommendation cites the metrics, queries, or page facts it relies on. Queries and sections must exist in your data." },
  { title: "Human approval", body: "Nothing is approved without a person. Recommendations and proposals each need an explicit decision." },
  { title: "Version-aware proposals", body: "Proposals are bound to the exact page version that was analyzed. If the page changes, re-analysis is required." },
  { title: "Validated AI output", body: "AI output is schema-checked and screened for ungrounded facts and promissory wording before it is shown." },
  { title: "Clear review history", body: "Original AI output, human edits, revisions, and approvals are kept separately and recorded in an audit log." },
];

const FAQ = [
  {
    q: "What is RankFix AI?",
    a: "RankFix AI is an SEO optimization workflow for existing pages. It reads your Google Search Console data, detects pages with opportunity signals, uses AI to explain the evidence and draft focused improvements, and keeps every change behind human review.",
  },
  {
    q: "How does it use Google Search Console?",
    a: "You connect a property through Google sign-in with read-only access. RankFix AI retrieves page and query performance (impressions, clicks, CTR, and average position) and uses it to detect and score opportunities. It cannot change anything in your Search Console account.",
  },
  {
    q: "Does it create new blog posts?",
    a: "No. RankFix AI focuses on improving pages you already have. Recommendations are limited to edits of existing content, such as titles, meta descriptions, headings, and sections. It does not propose new articles.",
  },
  {
    q: "Can I edit AI-generated drafts?",
    a: "Yes. Drafts pre-fill the proposed value, and you can edit them freely, request a new draft, or write your own copy. The original AI output is kept unchanged, and each proposal records whether it was edited.",
  },
  {
    q: "Does it publish changes automatically?",
    a: "No. Nothing is published automatically. Approved proposals are recorded and bound to the analyzed page version. Applying approved changes to a live website is not available yet.",
  },
  {
    q: "Does AI-generated content automatically hurt Google rankings?",
    a: "Google’s published guidance focuses on whether content is helpful and reliable rather than on how it was produced. That said, no tool can guarantee rankings, and RankFix AI makes no ranking promises. Drafts are restricted to facts already on your page, and every change is reviewed by a person.",
  },
  {
    q: "Is plagiarism checking available?",
    a: "An originality check is available for drafted titles, meta descriptions, headings, and intro text. It compares text against other pages crawled into your own project and flags verbatim or near-verbatim overlap. It does not search the public web, does not detect paraphrasing, and is not a guarantee that content is plagiarism-free.",
  },
  {
    q: "Is RankFix AI available yet?",
    a: "RankFix AI is in active development. Early-access signup on this page is not connected yet. You can follow progress, or run the current build yourself, from the GitHub repository.",
  },
];

// ───────────────────────── page ─────────────────────────

export default function LandingPage() {
  return (
    <div className={`lp-root ${geist.variable} min-h-screen bg-lp-bg font-display text-[16px] leading-relaxed text-lp-ink2 antialiased`}>
      <a href="#main" className="sr-only rounded-md bg-lp-ink px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50">
        Skip to content
      </a>
      <SiteHeader />
      <RevealOnScroll />

      <main id="main">
        {/* ── Hero ── */}
        <section id="product" aria-labelledby="hero-title" className="relative scroll-mt-16 overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[radial-gradient(60%_50%_at_50%_0%,rgb(58_74_240/0.10),transparent_70%)]"
          />
          <Container className="relative pb-16 pt-14 sm:pt-20 lg:pb-24 lg:pt-24">
            <div className="mx-auto max-w-[920px] text-center">
              <Eyebrow>SEO optimization, grounded in search data</Eyebrow>
              <Heading as="h1" className="mt-5 text-[40px] leading-[1.04] sm:text-[56px] lg:text-[72px]">
                Your Search Data Has Answers. <span className="text-brand">RankFix AI</span> Helps You Act on Them.
              </Heading>
              <p className="mx-auto mt-6 max-w-[680px] text-[17px] leading-relaxed text-lp-ink2 sm:text-[19px]">{DESCRIPTION}</p>
              <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                <PrimaryCta />
                <SecondaryCta href="#how-it-works">Explore the Workflow</SecondaryCta>
              </div>
              <p className="mt-6 text-[14px] font-medium text-lp-ink3">Real search data. Grounded recommendations. Human-controlled changes.</p>
            </div>
            <div className="mx-auto mt-14 max-w-[1100px] lg:mt-16" data-reveal>
              <HeroPreview />
              <p className="mt-3 text-center text-[12.5px] text-lp-ink3">Interface preview with illustrative data. Not a customer result.</p>
            </div>
          </Container>
        </section>

        {/* ── Problem → solution ── */}
        <section aria-labelledby="problem-title" className="border-y border-lp-line bg-white">
          <Container className="py-20 lg:py-28">
            <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
              <div data-reveal>
                <Eyebrow>The gap</Eyebrow>
                <Heading className="mt-4 text-[34px] leading-[1.08] sm:text-[44px]">
                  <span id="problem-title">Knowing Your Numbers Is Not the Same as Knowing What to Fix.</span>
                </Heading>
                <p className="mt-6 max-w-[460px] text-[17px]">
                  RankFix AI connects performance data, page evidence, AI recommendations, and human approval into one workflow, so a metric becomes a specific, reviewable change.
                </p>
              </div>
              <ol className="divide-y divide-lp-line">
                {PROBLEMS.map((p, i) => (
                  <li key={p.title} className="grid grid-cols-[48px_1fr] gap-4 py-7 first:pt-0" data-reveal>
                    <span className="font-display text-[15px] font-semibold tabular-nums text-lp-ink3">0{i + 1}</span>
                    <div>
                      <Heading as="h3" className="text-[22px] leading-snug">{p.title}</Heading>
                      <p className="mt-2 text-[16px]">{p.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </Container>
        </section>

        {/* ── How it works ── */}
        <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-16">
          <Container className="py-20 lg:py-28">
            <div className="mx-auto max-w-[720px] text-center" data-reveal>
              <Eyebrow>How it works</Eyebrow>
              <Heading className="mt-4 text-[34px] leading-[1.08] sm:text-[48px]">
                <span id="how-title">From search signal to approved change, in four steps.</span>
              </Heading>
            </div>
            <ol className="relative mt-16 grid gap-10 md:grid-cols-2 lg:grid-cols-4 lg:gap-6">
              <span aria-hidden="true" className="absolute left-0 right-0 top-[19px] hidden h-px bg-gradient-to-r from-brand/0 via-brand/40 to-brand/0 lg:block" />
              {STEPS.map((s, i) => (
                <li key={s.n} className="relative" data-reveal>
                  <span className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-brand/30 bg-lp-bg font-display text-[14px] font-semibold tabular-nums text-brand">
                    {s.n}
                  </span>
                  <Heading as="h3" className="mt-5 text-[22px]">{s.title}</Heading>
                  <p className="mt-2 text-[15.5px]">{s.body}</p>
                  <div className="mt-6">
                    <StepVisual step={(i + 1) as 1 | 2 | 3 | 4} />
                  </div>
                </li>
              ))}
            </ol>
          </Container>
        </section>

        {/* ── Features ── */}
        <section id="features" aria-labelledby="features-title" className="scroll-mt-16 border-t border-lp-line bg-white">
          <Container className="py-20 lg:py-28">
            <div className="max-w-[760px]" data-reveal>
              <Eyebrow>Features</Eyebrow>
              <Heading className="mt-4 text-[34px] leading-[1.08] sm:text-[48px]">
                <span id="features-title">Built for the work between the data and the fix.</span>
              </Heading>
            </div>

            <div className="mt-20 space-y-24 lg:space-y-32">
              <Feature
                eyebrow="Discover"
                title="Find the Pages Worth Fixing First."
                body="RankFix AI scans your Search Console data for existing pages with clear signals, scores them by the strength of their evidence, and ranks them so the most promising work comes first."
                points={[
                  "Low click-through rate for the page’s position",
                  "Search performance decline versus the previous period",
                  "High impressions with low clicks",
                  "Pages approaching stronger search positions",
                  "Content coverage signals from high-impression queries",
                ]}
                visual={<OpportunityTableMock />}
              />
              <Feature
                reverse
                eyebrow="Understand"
                title="Every Recommendation Starts With Evidence."
                body="For each opportunity, RankFix AI combines search performance, the crawled content of the page, and its most relevant queries. Observations, hedged interpretations, and search intent are kept separate, so you can see exactly what the reasoning rests on."
                points={["Observations tied to real metrics and page facts", "Interpretations stated with a confidence level", "Queries and sections checked against your actual data"]}
                visual={<AnalysisMock />}
              />
              <Feature
                eyebrow="Draft"
                title="Go From What to Fix to What to Write."
                body="RankFix AI drafts replacement copy for titles, meta descriptions, H1s, section headings, and eligible introductions. Each draft is checked before it reaches you. If it adds facts that aren’t on the page, is too long, or makes promises, it’s discarded and you write the copy instead."
                points={["Drafts use only facts already on the page", "Length limits per field", "Request a new draft when you want another option"]}
                visual={<DraftEditorMock />}
              />
              <Feature
                reverse
                eyebrow="Decide"
                title="AI Suggests. You Decide."
                body="Edit, approve, or reject every recommendation. Approving creates a concrete proposal that still needs your final approval. Revisions supersede earlier versions instead of overwriting them, and AI drafts are never published automatically."
                points={["Edit before approving; edits are recorded", "Revisions keep the full history", "Re-analysis required when the page changes"]}
                visual={<ReviewMock />}
              />
              <Feature
                eyebrow="Quality"
                title="Check Drafts Against Your Own Pages."
                body="Before a drafted title, description, heading, or intro is approved, RankFix AI checks it for verbatim or near-verbatim overlap with other pages in your project. Matches are shown with their source and an explanation, and significant overlap needs acknowledgment."
                points={["Compares with your project’s crawled pages, not the public web", "Common phrases and shared terminology aren’t flagged on their own", "Not a guarantee of originality or rankings"]}
                visual={<OriginalityMock />}
              />
            </div>
          </Container>
        </section>

        {/* ── Workflow showcase ── */}
        <section aria-labelledby="flow-title" className="bg-lp-ink text-white">
          <Container className="py-20 lg:py-28">
            <div className="mx-auto max-w-[760px] text-center" data-reveal>
              <p className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-[#9ba5ff]">One connected workflow</p>
              <h2 id="flow-title" className="mt-4 font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.035em] text-white sm:text-[48px]">
                Not a text generator. An optimization workflow.
              </h2>
              <p className="mx-auto mt-5 max-w-[600px] text-[17px] text-white/70">
                Every draft traces back to a search signal, and every change goes through a person.
              </p>
            </div>
            <ol className="mt-16 grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:gap-0" data-reveal>
              {FLOW.map((step, i) => (
                <li key={step} className="relative flex items-center gap-3 lg:flex-col lg:gap-4 lg:text-center">
                  {i < FLOW.length - 1 && (
                    <svg aria-hidden="true" className="absolute left-[calc(50%+28px)] top-[27px] hidden h-[2px] w-[calc(100%-56px)] lg:block" preserveAspectRatio="none" viewBox="0 0 100 2">
                      <line x1="0" y1="1" x2="100" y2="1" stroke="#7a62f6" strokeWidth="2" className="lp-flow-line" vectorEffect="non-scaling-stroke" />
                    </svg>
                  )}
                  <span
                    className={`relative inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border font-display text-[15px] font-semibold tabular-nums ${
                      i === FLOW.length - 1 ? "border-brand bg-brand text-white" : i === 4 ? "border-white/60 bg-white text-lp-ink" : "border-white/15 bg-white/5 text-white"
                    }`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[15px] font-semibold text-white lg:px-2">{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-12 text-center text-[13.5px] text-white/50">
              Applying approved changes to a live site and measuring results afterwards are not available yet.
            </p>
          </Container>
        </section>

        {/* ── Who it's for ── */}
        <section aria-labelledby="who-title">
          <Container className="py-20 lg:py-28">
            <div className="grid gap-12">
              <div className="max-w-[760px]" data-reveal>
                <Eyebrow>Who it’s for</Eyebrow>
                <Heading className="mt-4 text-[34px] leading-[1.08] sm:text-[44px]">
                  <span id="who-title">For the people responsible for pages that already exist.</span>
                </Heading>
                <p className="mt-5 text-[15.5px] text-lp-ink3">RankFix AI supports professional judgment; it doesn’t replace it.</p>
              </div>
              <ul className="grid gap-px overflow-hidden rounded-2xl border border-lp-line bg-lp-line sm:grid-cols-3">
                {AUDIENCES.map((a) => (
                  <li key={a.title} className="bg-lp-bg p-7" data-reveal>
                    <Heading as="h3" className="text-[20px]">{a.title}</Heading>
                    <p className="mt-3 text-[15.5px]">{a.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Container>
        </section>

        {/* ── Differentiation ── */}
        <section aria-labelledby="diff-title" className="border-y border-lp-line bg-white">
          <Container className="py-20 lg:py-28">
            <div className="mx-auto max-w-[720px] text-center" data-reveal>
              <Eyebrow>Why RankFix AI</Eyebrow>
              <Heading className="mt-4 text-[34px] leading-[1.08] sm:text-[48px]">
                <span id="diff-title">Not Another AI Blog Writer.</span>
              </Heading>
            </div>
            <div className="mx-auto mt-14 grid max-w-[980px] gap-5 md:grid-cols-2" data-reveal>
              <div className="rounded-2xl border border-lp-line bg-lp-bg p-7 sm:p-9">
                <h3 className="font-display text-[15px] font-semibold uppercase tracking-[0.1em] text-lp-ink3">Traditional workflow</h3>
                <ul className="mt-6 space-y-4">
                  {TRADITIONAL.map((t) => (
                    <li key={t} className="flex gap-3 text-[16px] text-lp-ink2">
                      <span aria-hidden="true" className="mt-[11px] h-px w-3 shrink-0 bg-lp-ink3" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border border-brand/30 bg-white p-7 shadow-frame sm:p-9">
                <h3 className="font-display text-[15px] font-semibold uppercase tracking-[0.1em] text-brand">With RankFix AI</h3>
                <ul className="mt-6 space-y-4">
                  {RANKFIX.map((t) => (
                    <li key={t} className="flex gap-3 text-[16px] font-medium text-lp-ink">
                      <Check />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Container>
        </section>

        {/* ── Trust / transparency ── */}
        <section aria-labelledby="trust-title">
          <Container className="py-20 lg:py-28">
            <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
              <div data-reveal>
                <Eyebrow>Transparency</Eyebrow>
                <Heading className="mt-4 text-[34px] leading-[1.08] sm:text-[44px]">
                  <span id="trust-title">Built around evidence, not promises.</span>
                </Heading>
                <p className="mt-5 max-w-[420px] text-[17px]">
                  RankFix AI is new, so there are no customer logos here. Instead, here is how it is built to keep recommendations honest.
                </p>
              </div>
              <dl className="grid gap-x-10 gap-y-9 sm:grid-cols-2">
                {PRINCIPLES.map((p) => (
                  <div key={p.title} className="border-t border-lp-line pt-5" data-reveal>
                    <dt className="flex gap-2 font-display text-[18px] font-semibold text-lp-ink"><Check />{p.title}</dt>
                    <dd className="mt-2 text-[15.5px]">{p.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Container>
        </section>

        {/* ── FAQ ── */}
        <section id="faq" aria-labelledby="faq-title" className="scroll-mt-16 border-t border-lp-line bg-white">
          <Container className="py-20 lg:py-28">
            <div className="grid gap-12 lg:grid-cols-[0.8fr_1.6fr] lg:gap-20">
              <div data-reveal>
                <Eyebrow>FAQ</Eyebrow>
                <Heading className="mt-4 text-[34px] leading-[1.08] sm:text-[44px]">
                  <span id="faq-title">Questions, answered plainly.</span>
                </Heading>
              </div>
              <div className="divide-y divide-lp-line border-y border-lp-line">
                {FAQ.map((f) => (
                  <details key={f.q} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-4 py-5 text-left font-display text-[17.5px] font-semibold text-lp-ink [&::-webkit-details-marker]:hidden">
                      <span className="flex-1">{f.q}</span>
                      <span aria-hidden="true" className="relative h-5 w-5 shrink-0">
                        <span className="absolute left-1/2 top-1/2 h-[2px] w-3.5 -translate-x-1/2 -translate-y-1/2 rounded bg-lp-ink2" />
                        <span className="absolute left-1/2 top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded bg-lp-ink2 transition-transform group-open:rotate-90 group-open:opacity-0" />
                      </span>
                    </summary>
                    <p className="max-w-[680px] pb-6 text-[16px]">{f.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </Container>
        </section>

        {/* ── Final CTA ── */}
        <section id="early-access" aria-labelledby="cta-title" className="scroll-mt-16 relative overflow-hidden border-t border-lp-line">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_100%,rgb(122_98_246/0.10),transparent_70%)]" />
          <Container className="relative py-24 text-center lg:py-32">
            <div data-reveal>
              <Heading className="mx-auto max-w-[860px] text-[38px] leading-[1.05] sm:text-[56px]">
                <span id="cta-title">Make Your Next SEO Improvement Evidence-Driven.</span>
              </Heading>
              <p className="mx-auto mt-6 max-w-[560px] text-[18px]">Turn search performance signals into specific, reviewable improvements for your existing content.</p>
              <div className="mt-10">
                <EarlyAccessForm />
              </div>
            </div>
          </Container>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-lp-line bg-lp-bg">
        <Container className="grid gap-10 py-14 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <Wordmark />
            <p className="mt-4 max-w-[340px] text-[14.5px]">Find SEO opportunities in Google Search Console data and turn them into evidence-based, human-approved improvements to existing pages.</p>
          </div>
          <nav aria-label="Footer">
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-lp-ink3">Product</h2>
            <ul className="mt-4 space-y-2.5 text-[14.5px]">
              {NAV.map((n) => (
                <li key={n.href}><a href={n.href} className="text-lp-ink2 no-underline hover:text-lp-ink">{n.label}</a></li>
              ))}
            </ul>
          </nav>
          <div>
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-lp-ink3">Project</h2>
            <ul className="mt-4 space-y-2.5 text-[14.5px]">
              <li><a href={REPO} target="_blank" rel="noopener noreferrer" className="text-lp-ink2 no-underline hover:text-lp-ink">GitHub repository ↗</a></li>
              <li><Link href="/login" className="text-lp-ink2 no-underline hover:text-lp-ink">Sign In</Link></li>
              <li><a href="#early-access" className="text-lp-ink2 no-underline hover:text-lp-ink">Get Early Access</a></li>
            </ul>
          </div>
        </Container>
        <Container className="border-t border-lp-line py-6 text-[13px] text-lp-ink3">
          © {new Date().getFullYear()} RankFix AI. Find SEO Opportunities. Fix What Matters.
        </Container>
      </footer>
    </div>
  );
}

function Feature({ eyebrow, title, body, points, visual, reverse = false }: { eyebrow: string; title: string; body: string; points: string[]; visual: ReactNode; reverse?: boolean }) {
  return (
    <article className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <div className={reverse ? "lg:order-2" : ""} data-reveal>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Heading as="h3" className="mt-4 text-[30px] leading-[1.1] sm:text-[38px]">{title}</Heading>
        <p className="mt-5 text-[17px]">{body}</p>
        <ul className="mt-6 space-y-3">
          {points.map((p) => (
            <li key={p} className="flex gap-3 text-[15.5px] text-lp-ink">
              <Check />
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className={`min-w-0 ${reverse ? "lg:order-1" : ""}`} data-reveal>{visual}</div>
    </article>
  );
}
