/**
 * A fetch double for adapter tests: routes requests to handlers and records every call.
 */
import type { AdapterContext } from "../../core/src/adapters";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = { status?: number; json?: unknown; text?: string };
export type Handler = (call: RecordedCall) => Reply | Promise<Reply>;
export type Matcher = string | RegExp | ((call: RecordedCall) => boolean);

export function fakeFetch(routes: Array<[Matcher, Handler | Reply]>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { url, method: (init?.method ?? "GET").toUpperCase(), headers, body };
    calls.push(call);
    for (const [matcher, handler] of routes) {
      const hit =
        typeof matcher === "string"
          ? url.includes(matcher)
          : matcher instanceof RegExp
            ? matcher.test(url)
            : matcher(call);
      if (!hit) continue;
      const reply = typeof handler === "function" ? await handler(call) : handler;
      const payload = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
      return new Response(payload, {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request: ${call.method} ${url}`);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

export function context(
  fetchImpl: typeof fetch,
  config: Record<string, string | undefined>,
  now?: Date,
): AdapterContext {
  return { fetch: fetchImpl, config, ...(now ? { now: () => now } : {}) };
}
