/**
 * Wiring for one request: a small Postgres pool through Hyperdrive, the
 * supplier/payment adapters built from Worker secrets, and the Bot API client.
 */
import { Pool, type PoolClient } from "pg";
import { loadStoreKeys, type ApiEnv, type Db, type Services } from "@store/api";
import type { AdapterContext, PaymentAdapter, PaymentMethod, SupplierAdapter } from "@store/core";
import { paymentFactories } from "@store/payments";
import { supplierFactories } from "@store/suppliers";

export interface WorkerEnv extends ApiEnv {
  HYPERDRIVE: { connectionString: string };
  /** Static files of the web app (dist/). */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

function clientDb(c: PoolClient): Db {
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      return (await c.query(text, [...params])).rows as T[];
    },
    tx: (fn) => fn(clientDb(c)),
  };
}

function poolDb(pool: Pool): Db {
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      return (await pool.query(text, [...params])).rows as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const out = await fn(clientDb(c));
        await c.query("commit");
        return out;
      } catch (err) {
        await c.query("rollback").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
  };
}

export interface RequestServices {
  svc: Services;
  /**
   * Add the payment and supplier keys set in Admin → Settings → Keys to the
   * adapters' settings. Call before handling a request that may use an adapter.
   * Never fails: without the database the Worker's own secrets are used.
   */
  ready(): Promise<void>;
  /** Wait for background work, then close the pool. Pass to ctx.waitUntil. */
  finish(): Promise<void>;
}

/**
 * How long one outgoing request may take before it is given up (it then fails
 * like a network error). Telegram, email and push answer in well under a
 * second; suppliers and payment providers get longer (their adapters usually
 * set their own, shorter limit).
 */
export const FETCH_TIMEOUT_MS = 10_000;
export const ADAPTER_TIMEOUT_MS = 30_000;
/** Database: connecting (through Hyperdrive) and one query, from the Worker's side. */
export const DB_CONNECT_TIMEOUT_MS = 5_000;
export const DB_QUERY_TIMEOUT_MS = 20_000;

export function createServices(env: WorkerEnv): RequestServices {
  // Hyperdrive pools the real connections; a small per-request pool is the recommended pattern.
  // A slow or unreachable database fails the request instead of holding it
  // (the database also stops a statement after 30 s: 0031_reliability.sql).
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    max: 5,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    query_timeout: DB_QUERY_TIMEOUT_MS,
  });
  const pending: Promise<unknown>[] = [];
  // Adapters get only string settings (secrets and vars), never bindings.
  const config = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  // Every outgoing request counts against the Worker's per-invocation limit
  // (50 on the free plan). Jobs ask svc.budget before starting more work.
  const limit = Number(env.SUBREQUEST_LIMIT) > 0 ? Number(env.SUBREQUEST_LIMIT) : 50;
  let used = 0;
  // Every request also gets a time limit, unless the caller set its own signal.
  const countedWithin = (ms: number): typeof fetch => (input, init) => {
    used++;
    return fetch(input, init?.signal ? init : { ...init, signal: AbortSignal.timeout(ms) });
  };
  const counted = countedWithin(FETCH_TIMEOUT_MS);
  const adapterCtx: AdapterContext = { fetch: countedWithin(ADAPTER_TIMEOUT_MS), config };
  const suppliers = new Map<string, SupplierAdapter | null>();
  const payments = new Map<PaymentMethod, PaymentAdapter | null>();

  const svc: Services = {
    db: poolDb(pool),
    supplier(id) {
      if (!suppliers.has(id)) {
        const factory = supplierFactories[id];
        let adapter: SupplierAdapter | null = null;
        try {
          adapter = factory ? factory(adapterCtx) : null;
        } catch (err) {
          console.error(`supplier ${id} not configured:`, err instanceof Error ? err.message : String(err));
        }
        suppliers.set(id, adapter);
      }
      return suppliers.get(id) ?? null;
    },
    payment(method, extra) {
      if (extra) {
        // Settings from the database (e.g. the Stars rate) on top of the Worker's own.
        try {
          return paymentFactories[method]({ ...adapterCtx, config: { ...config, ...extra } });
        } catch (err) {
          console.error(`payment ${method} not configured:`, err instanceof Error ? err.message : String(err));
          return null;
        }
      }
      if (!payments.has(method)) {
        let adapter: PaymentAdapter | null = null;
        try {
          adapter = paymentFactories[method](adapterCtx);
        } catch (err) {
          console.error(`payment ${method} not configured:`, err instanceof Error ? err.message : String(err));
        }
        payments.set(method, adapter);
      }
      return payments.get(method) ?? null;
    },
    now: () => new Date(),
    fetch: counted,
    budget: { left: () => limit - used },
    waitUntil: (p) => {
      pending.push(p);
    },
    async telegram(method, payload, bot = "store") {
      // config holds the Worker's secrets plus the admin's keys (after ready()).
      const token = bot === "staff" && config.NOTIFY_BOT_TOKEN ? config.NOTIFY_BOT_TOKEN : env.TELEGRAM_BOT_TOKEN;
      const res = await counted(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
      if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
      return data.result;
    },
  };

  return {
    svc,
    async ready() {
      try {
        const keys = await loadStoreKeys(svc.db, env.DATA_KEY);
        Object.assign(config, keys);
        // Adapters built before this point (none, when called first) would hold the old settings.
        suppliers.clear();
        payments.clear();
      } catch (err) {
        console.error("store keys not loaded:", err instanceof Error ? err.message : String(err));
      }
    },
    async finish() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
      await pool.end().catch(() => {});
    },
  };
}
