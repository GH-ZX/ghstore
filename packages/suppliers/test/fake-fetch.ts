/**
 * A recording fake for `ctx.fetch`. Routes are keyed "METHOD /path?query"
 * (query optional: an exact match wins, then the bare path). A handler may be
 * a function or a list consumed one call at a time.
 */
import type { AdapterContext } from "../../core/src/adapters";

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (req: Recorded) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Handler {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function text(body: string, status = 200): Handler {
  return () => new Response(body, { status });
}

export function networkError(): Handler {
  return () => {
    throw new TypeError("fetch failed: connection reset");
  };
}

export function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const rec: Recorded = { method, url, path: u.pathname + u.search, headers, body };
    calls.push(rec);
    const entry = routes[`${method} ${u.pathname}${u.search}`] ?? routes[`${method} ${u.pathname}`];
    const handler = Array.isArray(entry) ? entry.shift() : entry;
    if (!handler) throw new Error(`fake fetch: unexpected ${method} ${u.pathname}${u.search}`);
    return handler(rec);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export function context(routes: Record<string, Handler | Handler[]>, config: Record<string, string | undefined>) {
  const fake = fakeFetch(routes);
  const ctx: AdapterContext = { fetch: fake.fetch, config };
  return { ctx, calls: fake.calls };
}
