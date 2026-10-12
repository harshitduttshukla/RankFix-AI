"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Wordmark } from "./logo";
import { NAV } from "./nav";


const navLink = "rounded-md px-3 py-2 text-[14.5px] font-medium text-lp-ink2 no-underline transition-colors hover:text-lp-ink";

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={`sticky top-0 z-40 border-b bg-lp-bg transition-colors ${scrolled || open ? "border-lp-line" : "border-transparent"}`}>
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-6 px-5 sm:px-8">
        <Link href="/" className="no-underline" aria-label="RankFix AI home">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="mx-auto hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} className={navLink}>{n.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto hidden items-center gap-2 md:ml-0 md:flex">
          <Link href="/login" className={navLink}>Sign In</Link>
          <a href="#early-access" className="rounded-lg bg-lp-ink px-4 py-2.5 text-[14px] font-semibold text-white no-underline transition-colors hover:bg-brand">
            Get Early Access
          </a>
        </div>
        <button
          type="button"
          className="ml-auto inline-flex h-11 w-11 items-center justify-center rounded-lg text-lp-ink md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>
      {open && (
        <nav id="mobile-nav" aria-label="Main" className="border-t border-lp-line bg-lp-bg px-5 pb-6 pt-2 md:hidden">
          <ul className="flex flex-col">
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} onClick={() => setOpen(false)} className="block border-b border-lp-line2 py-3.5 text-[17px] font-medium text-lp-ink no-underline">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-col gap-3">
            <a href="#early-access" onClick={() => setOpen(false)} className="rounded-lg bg-lp-ink px-4 py-3.5 text-center text-[15px] font-semibold text-white no-underline">
              Get Early Access
            </a>
            <Link href="/login" className="rounded-lg border border-lp-line px-4 py-3.5 text-center text-[15px] font-medium text-lp-ink no-underline">
              Sign In
            </Link>
          </div>
        </nav>
      )}
    </header>
  );
}
