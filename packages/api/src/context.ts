/**
 * Request context and the services handlers depend on. Everything external is
 * injected (database, adapters, clock, fetch) so the whole API runs in tests
 * against a local Postgres with fake suppliers and payment providers.
 */
import type { PaymentAdapter, PaymentMethod, SupplierAdapter } from "@store/core";
import type { Db } from "./db";

/** Secrets and settings. In Workers these come from `wrangler secret put` / vars. */
export interface ApiEnv {
  /** 32+ random characters. Signs session tokens. */
  SESSION_SECRET: string;
  /** 32 random bytes, base64. Encrypts delivered codes and supplier keys. */
  DATA_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  /** Random string registered with setWebhook; Telegram echoes it in a header. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Telegram user ids (comma separated) that become owners on first sign-in. */
  OWNER_TELEGRAM_IDS?: string;
  /** Public base URL of the site, e.g. https://gh-store.me (no trailing slash). */
  PUBLIC_BASE_URL: string;
  /** Supabase project URL and publishable key, used only to verify website logins. */
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  /** Comma-separated payment methods to offer: sam,nowpayments,bep20,stars */
  PAYMENT_METHODS?: string;
  /** Stars per US dollar for Telegram Stars top-ups. */
  STARS_PER_USD?: string;
  /** Anything else (supplier and payment keys, bindings) — strings are passed to adapters as config. */
  [key: string]: unknown;
}

export interface Services {
  db: Db;
  supplier(id: string): SupplierAdapter | null;
  payment(method: PaymentMethod): PaymentAdapter | null;
  now(): Date;
  /** fetch for outgoing calls (Supabase Auth checks). Injected so tests can fake it. */
  fetch: typeof fetch;
  /** Background work that may continue after the response (Workers ctx.waitUntil). */
  waitUntil(p: Promise<unknown>): void;
  /** Send a Telegram Bot API request (injected so tests can capture it). */
  telegram(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface AuthedUser {
  id: string;
  role: "customer" | "support" | "owner";
  locale: "ar" | "en";
  sessionId: string;
  channel: "web" | "miniapp" | "admin";
}

export interface Ctx {
  req: Request;
  url: URL;
  env: ApiEnv;
  svc: Services;
  params: Record<string, string>;
}
