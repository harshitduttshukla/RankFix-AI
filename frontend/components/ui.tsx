import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { ApiError } from "@/lib/api";

export function Button({ className = "", variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const styles =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-700 disabled:bg-zinc-400"
      : "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-100 disabled:text-zinc-400";
  return <button className={`rounded-md px-3.5 py-2 text-sm font-medium transition-colors ${styles} ${className}`} {...props} />;
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-zinc-700">{label}</span>
      <input
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
        {...props}
      />
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      {title && (
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? fieldMessage(error) : "Something went wrong";
  return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
}

function fieldMessage(err: ApiError) {
  const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
  const first = fields && Object.values(fields).flat()[0];
  return first ?? err.message;
}
