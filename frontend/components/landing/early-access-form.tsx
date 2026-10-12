"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Early-access request form. There is no signup endpoint yet, so the form validates input and then says plainly
 * that nothing was sent. It never shows a fake success state.
 */
export function EarlyAccessForm() {
  const id = useId();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setError("Enter a valid email address, like name@company.com.");
      setNotice(false);
      return;
    }
    setError(null);
    setNotice(true);
  }

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor={`${id}-email`} className="sr-only">Work email</label>
        <input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={`${id}-status`}
          className="h-12 flex-1 rounded-lg border border-lp-line bg-white px-4 text-[15px] text-lp-ink outline-none placeholder:text-lp-ink3 focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        <button type="submit" className="h-12 rounded-lg bg-brand px-6 text-[15px] font-semibold text-white transition-colors hover:bg-brand-dark">
          Get Early Access
        </button>
      </form>
      <div id={`${id}-status`} aria-live="polite" className="mt-3 min-h-[1.5em] text-left text-[13.5px]">
        {error && <p className="text-lp-warn">{error}</p>}
        {notice && (
          <p className="rounded-lg border border-lp-line bg-white px-4 py-3 text-lp-ink2">
            Early-access signup isn’t connected yet, so <strong className="text-lp-ink">nothing was submitted</strong> and your email wasn’t stored.
            You can <Link href="/register" className="font-medium text-brand underline">create an account</Link> to try the current build, or follow progress on{" "}
            <a href="https://github.com/harshitduttshukla/RankFix-AI" className="font-medium text-brand underline" rel="noopener noreferrer" target="_blank">GitHub</a>.
          </p>
        )}
      </div>
    </div>
  );
}
