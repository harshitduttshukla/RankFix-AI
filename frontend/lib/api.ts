export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.split("=")[1];
}

let csrfPromise: Promise<string> | null = null;
async function csrfToken(): Promise<string> {
  const existing = readCookie("csrf_token");
  if (existing) return existing;
  csrfPromise ??= fetch("/api/auth/csrf", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((b: { csrfToken: string }) => b.csrfToken)
    .finally(() => (csrfPromise = null));
  return csrfPromise;
}

let refreshPromise: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  refreshPromise ??= (async () => {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-csrf-token": await csrfToken() },
    });
    return res.ok;
  })().finally(() => (refreshPromise = null));
  return refreshPromise;
}

const NO_REFRESH = ["/api/auth/login", "/api/auth/register", "/api/auth/refresh"];

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = await csrfToken();

  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 401 && !retried && !NO_REFRESH.includes(path) && (await refreshSession())) {
    return api<T>(path, init, true);
  }
  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? "INTERNAL_ERROR", e.message ?? "Request failed", e.details);
  }
  return body as T;
}
