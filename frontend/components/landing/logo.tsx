/** RankFix AI mark: three rising bars, the tallest finished with a check (opportunity found, fix approved). */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--color-brand)" />
      <rect x="7" y="17" width="4" height="8" rx="1.5" fill="#fff" opacity="0.55" />
      <rect x="14" y="12" width="4" height="13" rx="1.5" fill="#fff" opacity="0.8" />
      <path d="M20.5 13.5l2.6 2.6 5-6.1" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="21" y="18" width="4" height="7" rx="1.5" fill="#fff" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark />
      <span className="font-display text-[17px] font-semibold tracking-[-0.02em] text-lp-ink">
        RankFix <span className="text-brand">AI</span>
      </span>
    </span>
  );
}
