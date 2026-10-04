"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useLogin, useRegister } from "@/hooks/use-auth";
import { Button, ErrorText, Field } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const login = useLogin();
  const register = useRegister();
  const mutation = mode === "login" ? login : register;
  const [form, setForm] = useState({ email: "", password: "", name: "" });

  const next = params.get("next");
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const onSuccess = () => router.replace(destination);
    if (mode === "login") login.mutate({ email: form.email, password: form.password }, { onSuccess });
    else register.mutate({ email: form.email, password: form.password, name: form.name || undefined }, { onSuccess });
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-card p-6">
        <div className="flex items-center gap-2 text-[12px] text-ink3">
          <span className="h-[9px] w-[9px] rounded-full bg-teal" /> Blog Optimizer
        </div>
        <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
        {mode === "register" && (
          <Field label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
        )}
        <Field label="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
        <Field
          label="Password"
          type="password"
          required
          minLength={mode === "register" ? 10 : undefined}
          hint={mode === "register" ? "At least 10 characters" : undefined}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
        <ErrorText error={mutation.error} />
        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </Button>
        <p className="text-center text-[13px] text-ink2">
          {mode === "login" ? (
            <>No account? <Link className="underline underline-offset-2" href="/register">Create one</Link></>
          ) : (
            <>Have an account? <Link className="underline underline-offset-2" href="/login">Sign in</Link></>
          )}
        </p>
      </form>
    </div>
  );
}
