/**
 * Talking to the store API. On the website the session is an HttpOnly cookie;
 * in the Telegram Mini App it is a bearer token kept for this tab only.
 */

let token: string | null = null;
const TOKEN_KEY = "gh.session";

try {
  token = sessionStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage can be unavailable; the token still lives in memory */
  }
}

export function hasToken(): boolean {
  return token !== null;
}

/** An error the API returned on purpose: a stable code the UI translates. */
export class ApiFail extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(code);
    this.name = "ApiFail";
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiFail("network", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; field?: string } } | null)?.error;
    if (res.status === 401 && token) setToken(null);
    throw new ApiFail(e?.code ?? "internal", res.status, e?.field);
  }
  return data as T;
}

/** Send a file (a picture) as the request body, with the current session. */
export async function apiUpload<T>(path: string, file: Blob): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": file.type || "application/octet-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers, body: file, credentials: "same-origin" });
  } catch {
    throw new ApiFail("network", 0);
  }
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; field?: string } } | null;
  if (!res.ok) throw new ApiFail(data?.error?.code ?? "internal", res.status, data?.error?.field);
  return data as T;
}

/** Download a file the API makes (a CSV export) with the current session, under the server's file name. */
export async function download(path: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { headers, credentials: "same-origin" });
  } catch {
    throw new ApiFail("network", 0);
  }
  if (!res.ok) {
    const e = ((await res.json().catch(() => null)) as { error?: { code?: string; field?: string } } | null)?.error;
    throw new ApiFail(e?.code ?? "internal", res.status, e?.field);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export.csv";
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A random key so a retried request (double tap, flaky network) is applied once. */
export function idempotencyKey(): string {
  return crypto.randomUUID();
}
