import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { ApiError } from "@/lib/api";

const BUTTON = {
  primary: "border-teal bg-teal text-white hover:bg-teal-dark",
  secondary: "border-line bg-white text-ink hover:bg-[#f5f8f7]",
  danger: "border-coral-br bg-white text-coral hover:bg-coral-bg",
};

export function Button({
  className = "",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON }) {
  return (
    <button
      className={`cursor-pointer rounded-md border px-3 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12.5px] font-medium text-ink2">{label}</span>
      <input
        className="w-full rounded-[5px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink3 focus:border-teal focus:ring-1 focus:ring-teal"
        {...props}
      />
      {hint && <span className="block text-[11.5px] text-ink3">{hint}</span>}
    </label>
  );
}

export const selectClass = "rounded-[5px] border border-line bg-white px-2 py-1.5 text-[13px] text-ink";

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-card">
      {title && (
        <header className="flex flex-wrap items-center gap-2.5 border-b border-line2 px-[15px] py-[11px]">
          <h3 className="min-w-[140px] flex-1">{title}</h3>
          {action}
        </header>
      )}
      <div className="p-[15px]">{children}</div>
    </section>
  );
}

const TONE = {
  teal: "bg-teal-bg text-teal border-teal-br",
  coral: "bg-coral-bg text-coral border-coral-br",
  rest: "bg-rest-bg text-rest border-rest-br",
};
export type Tone = keyof typeof TONE;

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <div className={`flex flex-wrap items-center gap-3 rounded-lg border px-[15px] py-[11px] text-[13px] ${TONE[tone]}`}>{children}</div>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? fieldMessage(error) : "Something went wrong";
  return <Banner tone="coral">{message}</Banner>;
}

function fieldMessage(err: ApiError) {
  const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
  const first = fields && Object.values(fields).flat()[0];
  return first ?? err.message;
}
