/**
 * Test harness: the real API against a real Postgres (TEST_DATABASE_URL), with
 * fake suppliers, fake payment providers and a captured Telegram client.
 */
import { hmacSha256, toHex, utf8, type PaymentAdapter, type PaymentMethod, type SupplierAdapter } from "@store/core";
import type { ApiEnv, Db, Services } from "../src/index";
import { handle } from "../src/index";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/store_api_test";
export const BOT_TOKEN = "123456:TEST-bot-token-not-real";

export const env: ApiEnv = {
  SESSION_SECRET: "test-session-secret-0123456789-abcdefghij",
  DATA_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7) & 255))),
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  PUBLIC_BASE_URL: "https://store.test",
  OWNER_TELEGRAM_IDS: "900001",
  PAYMENT_METHODS: "sam,nowpayments,bep20,stars",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-abcdef123456",
  // The keys each payment method needs before it is offered (the adapters themselves are fakes).
  SAM_API_KEY: "test-sam-key",
  SAM_WEBHOOK_SECRET: "test-sam-webhook-secret",
  NOWPAYMENTS_API_KEY: "test-np-key",
  NOWPAYMENTS_IPN_SECRET: "test-np-ipn",
  BEP20_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

/** A Db over any driver exposing unsafe(text, params) and begin(fn) (Bun.SQL here, postgres.js in production). */
export interface SqlLike {
  unsafe(text: string, params?: unknown[]): Promise<unknown>;
  begin<T>(fn: (tx: SqlLike) => Promise<T>): Promise<T>;
}

/** Connect with Bun's built-in client under `bun test`, or postgres.js under vitest/Node (CI). */
export async function connectTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const g = globalThis as { Bun?: unknown };
  if (g.Bun) {
    const { SQL } = await import("bun" as string);
    const sql = new SQL(TEST_DATABASE_URL);
    return { db: makeDb(sql as SqlLike), close: () => sql.close() };
  }
  const { default: postgres } = await import("postgres" as string);
  const sql = postgres(TEST_DATABASE_URL, { max: 4, onnotice: () => {} });
  return { db: makeDb(sql as SqlLike), close: () => sql.end() };
}

export function makeDb(sql: SqlLike, inTx = false): Db {
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      return (await sql.unsafe(text, [...params])) as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (inTx) return fn(makeDb(sql, true));
      return sql.begin((tx) => fn(makeDb(tx, true)));
    },
  };
}

export class Harness {
  pending: Promise<unknown>[] = [];
  telegramCalls: { method: string; payload: Record<string, unknown> }[] = [];
  suppliers = new Map<string, SupplierAdapter>();
  payments = new Map<PaymentMethod, PaymentAdapter>();
  fetchImpl: typeof fetch = async () => new Response("not mocked", { status: 500 });
  svc: Services;

  constructor(readonly db: Db) {
    this.svc = {
      db,
      supplier: (id) => this.suppliers.get(id) ?? null,
      payment: (m) => this.payments.get(m) ?? null,
      now: () => new Date(),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => this.fetchImpl(input, init)) as typeof fetch,
      waitUntil: (p) => {
        this.pending.push(p);
      },
      telegram: async (method, payload) => {
        this.telegramCalls.push({ method, payload });
        return { ok: true };
      },
    };
  }

  async settle(): Promise<void> {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }

  async call(method: string, path: string, opts: { token?: string; body?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.origin !== null) headers.origin = opts.origin ?? env.PUBLIC_BASE_URL;
    const res = await handle(
      new Request(`${env.PUBLIC_BASE_URL}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      env,
      this.svc,
    );
    const data = (await res.json()) as Record<string, any>;
    return { status: res.status, data };
  }

  /** Sign in through the real Telegram initData check. */
  async login(telegramId: number, name = "Tester", lang = "ar"): Promise<string> {
    const fields: Record<string, string> = {
      auth_date: String(Math.floor(Date.now() / 1000) - 5),
      query_id: "AAE",
      user: JSON.stringify({ id: telegramId, first_name: name, language_code: lang }),
    };
    const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secret = await hmacSha256(utf8("WebAppData"), BOT_TOKEN);
    const hash = toHex(await hmacSha256(secret, dcs));
    const initData = new URLSearchParams({ ...fields, hash }).toString();
    const r = await this.call("POST", "/api/auth/telegram", { body: { initData } });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
    return r.data.token as string;
  }
}
