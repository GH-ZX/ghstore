/**
 * The Worker's request budget (services.ts): every outgoing request is counted
 * against the per-invocation limit, whichever way it goes out (svc.fetch, an
 * adapter, the Bot API), and each gets a time limit unless it brought its own.
 * Nothing here reaches the network: fetch is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupplierAdapter } from "@store/core";
import { supplierFactories } from "@store/suppliers";
import { ADAPTER_TIMEOUT_MS, createServices, FETCH_TIMEOUT_MS, type WorkerEnv } from "../src/services";

const env = {
  HYPERDRIVE: { connectionString: "postgres://nobody@127.0.0.1:1/none" },
  ASSETS: { fetch: async () => new Response("") },
  TELEGRAM_BOT_TOKEN: "123:test",
  SESSION_SECRET: "x".repeat(40),
  DATA_KEY: "AAAA",
  PUBLIC_BASE_URL: "https://store.test",
} as unknown as WorkerEnv;

let calls: { url: string; init: RequestInit | undefined }[] = [];
let timeouts: number[] = [];

beforeEach(() => {
  calls = [];
  timeouts = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { headers: { "content-type": "application/json" } });
  });
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    timeouts.push(ms);
    return real(ms);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete supplierFactories.budget_test;
});

describe("request budget", () => {
  it("starts at the free plan's 50, or SUBREQUEST_LIMIT", async () => {
    const a = createServices(env);
    expect(a.svc.budget?.left()).toBe(50);
    const b = createServices({ ...env, SUBREQUEST_LIMIT: "1000" } as WorkerEnv);
    expect(b.svc.budget?.left()).toBe(1000);
    const c = createServices({ ...env, SUBREQUEST_LIMIT: "nonsense" } as WorkerEnv);
    expect(c.svc.budget?.left()).toBe(50);
    await Promise.all([a.finish(), b.finish(), c.finish()]);
  });

  it("counts every request: svc.fetch, the Bot API and the adapters'", async () => {
    supplierFactories.budget_test = (ctx) =>
      ({ id: "budget_test", getBalance: async () => (await ctx.fetch("https://supplier.test/balance"), null) }) as unknown as SupplierAdapter;
    const { svc, finish } = createServices(env);
    await svc.fetch("https://example.test/a");
    expect(svc.budget?.left()).toBe(49);
    await svc.telegram("sendMessage", { chat_id: "1", text: "hi" });
    expect(svc.budget?.left()).toBe(48);
    expect(calls[1]!.url).toBe("https://api.telegram.org/bot123:test/sendMessage");
    await svc.supplier("budget_test")!.getBalance();
    expect(svc.budget?.left()).toBe(47);
    expect(calls.map((c) => c.url)).toEqual(["https://example.test/a", "https://api.telegram.org/bot123:test/sendMessage", "https://supplier.test/balance"]);
    await finish();
  });

  it("only counts: past the limit it reads below zero and the jobs (room()) stop asking", async () => {
    const { svc, finish } = createServices({ ...env, SUBREQUEST_LIMIT: "2" } as WorkerEnv);
    await svc.fetch("https://example.test/1");
    await svc.fetch("https://example.test/2");
    expect(svc.budget?.left()).toBe(0);
    // The Worker runtime is what refuses the 51st request on the free plan; the counter just keeps going.
    await svc.fetch("https://example.test/3");
    expect(svc.budget?.left()).toBe(-1);
    const { room } = await import("../../../packages/api/src/budget");
    expect(room(svc)).toBe(0);
    await finish();
  });

  it("gives each request a time limit, 10 s, or 30 s for adapters, unless it has its own signal", async () => {
    supplierFactories.budget_test = (ctx) =>
      ({ id: "budget_test", getBalance: async () => (await ctx.fetch("https://supplier.test/balance"), null) }) as unknown as SupplierAdapter;
    const { svc, finish } = createServices(env);
    await svc.fetch("https://example.test/a", { method: "POST" });
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init?.method).toBe("POST");
    await svc.supplier("budget_test")!.getBalance();
    expect(timeouts).toEqual([FETCH_TIMEOUT_MS, ADAPTER_TIMEOUT_MS]);
    // A caller's own signal is kept as it is.
    const own = new AbortController().signal;
    await svc.fetch("https://example.test/b", { signal: own });
    expect(calls[2]!.init?.signal).toBe(own);
    expect(timeouts).toHaveLength(2);
    expect(svc.budget?.left()).toBe(47);
    await finish();
  });
});
