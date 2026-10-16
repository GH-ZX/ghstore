/**
 * Helpers shared by the supplier adapters.
 *
 * Web-standard APIs only (fetch via the injected context, crypto.subtle,
 * TextEncoder, URL), so every adapter runs unchanged on Cloudflare Workers.
 * Nothing here logs: error messages are built from status codes and supplier
 * wording, with every configured secret redacted.
 */
import { AdapterError } from "../../core/src/adapters";
import type {
  AdapterContext,
  DeliveredItem,
  DeliveryKind,
  PurchaseResult,
} from "../../core/src/adapters";
import { toCents } from "../../core/src/money";

export const TIMEOUT_MS = 15_000;

// ------------------------------------------------------------------ config

/** A trimmed config value; empty strings count as missing. */
export function cfg(ctx: AdapterContext, key: string): string | undefined {
  const value = ctx.config[key]?.trim();
  return value ? value : undefined;
}

export function baseUrl(ctx: AdapterContext, key: string, fallback: string): string {
  return (cfg(ctx, key) ?? fallback).replace(/\/+$/, "");
}

/** Comma-separated config list, lowercased. */
export function csv(ctx: AdapterContext, key: string): string[] {
  return (cfg(ctx, key) ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** Per-supplier webhook secret, falling back to the shared one the old bot used. */
export function webhookSecret(ctx: AdapterContext, key: string): string | undefined {
  return cfg(ctx, key) ?? cfg(ctx, "SUPPLIER_WEBHOOK_SECRET");
}

// ------------------------------------------------------------------ loose JSON readers

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function obj(value: unknown): Obj | undefined {
  return isObj(value) ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-empty trimmed string, or a finite number as a string. */
export function str(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** First non-empty value among several possible field names. */
export function pick(fields: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fields[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Send a numeric id as a JSON number, anything else as a string. */
export function numericOr(id: string): number | string {
  return /^\d{1,15}$/.test(id) ? Number(id) : id;
}

// ------------------------------------------------------------------ money

/**
 * A USD amount (number or numeric string, as suppliers send it) to integer
 * cents, rounding half up on the third decimal. Null for anything unusable,
 * negative included — a product with an unreadable price must not be sold.
 */
export function usdToCents(value: unknown): number | null {
  try {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0 || value > 1e12) return null;
      return toCents(value.toFixed(6));
    }
    if (typeof value === "string") {
      const s = value.trim();
      const match = /^(\d+)(?:\.(\d+))?$/.exec(s);
      if (!match) return null;
      return toCents(match[2] ? `${match[1]}.${match[2].slice(0, 8)}` : s);
    }
  } catch {
    return null;
  }
  return null;
}

// ------------------------------------------------------------------ HTTP

export interface HttpResult {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
  headers: Headers;
}

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Values that must never appear in an error message (API keys...). */
  secrets?: string[];
}

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("***");
  return out;
}

/**
 * One request. A transport failure (DNS, reset, timeout) throws a retryable
 * AdapterError; any HTTP answer, error statuses included, is returned.
 */
export async function http(
  ctx: AdapterContext,
  adapter: string,
  url: string,
  opts: HttpOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    const why = err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : "request failed";
    throw new AdapterError(adapter, `network error: ${redact(why, opts.secrets)}`, true);
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

/** The supplier's own wording for a failure, shortened and redacted. */
export function supplierMessage(r: HttpResult, secrets: string[] = []): string {
  const body = obj(r.json);
  let message: unknown = body?.message ?? body?.error ?? body?.msg;
  const detail = body?.detail;
  if (message === undefined && isObj(detail)) message = detail.message;
  if (message === undefined && typeof detail === "string") message = detail;
  let text = typeof message === "string" ? message : "";
  if (!text && r.json === null && !r.text.trimStart().startsWith("<")) text = r.text;
  const clean = redact(text.replace(/\s+/g, " ").trim(), secrets).slice(0, 200);
  return clean || `HTTP ${r.status}`;
}

export interface Failure {
  retryable: boolean;
  reason: string;
}

/** Generic status classification: auth and other 4xx are final, 429/5xx are not. */
export function httpFailure(status: number, message: string): Failure {
  if (status === 401 || status === 403) return { retryable: false, reason: `supplier rejected the credentials (HTTP ${status})` };
  if (status === 429) return { retryable: true, reason: "supplier rate limit reached" };
  if (status >= 500) return { retryable: true, reason: `supplier server error (HTTP ${status})` };
  return { retryable: false, reason: message };
}

/** For reads (catalogue, balance, status): a failed HTTP answer as a thrown AdapterError. */
export function httpError(adapter: string, r: HttpResult, secrets: string[] = []): AdapterError {
  const failure = httpFailure(r.status, `HTTP ${r.status}: ${supplierMessage(r, secrets)}`);
  return new AdapterError(adapter, failure.reason, failure.retryable);
}

export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;
export const isTransient = (r: HttpResult): boolean => isTransientStatus(r.status);

// ------------------------------------------------------------------ purchase results

export function failed(reason: string, retryable: boolean, supplierOrderId?: string): PurchaseResult {
  return supplierOrderId === undefined
    ? { status: "failed", retryable, reason }
    : { status: "failed", retryable, reason, supplierOrderId };
}

const LOW_BALANCE = /balance|funds|solde|رصيد/i;
const OUT_OF_STOCK = /stock|rupture|[ée]puis[ée]|no items|no free phones|quantity unavailable/i;

/**
 * A refused purchase. Both old codebases parked an order the supplier refused
 * for lack of funds in OUR wallet (held / pending_supplier_recharge) instead
 * of refunding it, so that case is retryable once the wallet is topped up.
 * Out of stock and other business refusals are final.
 */
export function refusal(status: number, message: string): PurchaseResult {
  if (status === 401 || status === 403 || isTransientStatus(status)) {
    const f = httpFailure(status, message);
    return failed(f.reason, f.retryable);
  }
  if (status === 402 || LOW_BALANCE.test(message)) {
    return failed(`supplier wallet balance too low: ${message}`, true);
  }
  if (OUT_OF_STOCK.test(message)) return failed(`out of stock at supplier: ${message}`, false);
  const f = httpFailure(status, message);
  return failed(f.reason, f.retryable);
}

/**
 * An exception during purchase. AdapterErrors keep their retryability; anything
 * else leaves the order state unknown, and a retry with the same idempotency
 * key is the safe way to find out.
 */
export function caught(err: unknown): PurchaseResult {
  if (err instanceof AdapterError) return failed(err.message, err.retryable);
  return failed("unexpected adapter error; supplier state unknown", true);
}

// ------------------------------------------------------------------ deliveries

const VALUE_KEYS = ["account_data", "code", "pin", "key", "value", "serial", "credentials", "token", "account", "data"];

/** Flatten whatever a supplier delivered into display strings (codes, credentials...). */
export function deliveryValues(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (typeof raw === "number" || typeof raw === "boolean") return [String(raw)];
  if (Array.isArray(raw)) return raw.flatMap(deliveryValues);
  if (isObj(raw)) {
    for (const key of VALUE_KEYS) {
      if (raw[key] !== undefined && raw[key] !== null) return deliveryValues(raw[key]);
    }
    return [JSON.stringify(raw)];
  }
  return [];
}

/** URLs are links; everything else keeps the product's delivery kind. */
export function itemsFrom(values: string[], kind: DeliveryKind): DeliveredItem[] {
  return values.map((value) => ({ kind: /^https?:\/\/\S+$/i.test(value) ? "link" : kind, value }));
}

// ------------------------------------------------------------------ crypto

const enc = new TextEncoder();

/** Constant-time comparison that also hides the secret's length (compares SHA-256 digests). */
export async function secretEquals(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stamp(bytes: Uint8Array, version: number): Uint8Array {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | (version << 4);
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytes;
}

export const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4122 name-based UUID (SHA-1), identical to Python's uuid.uuid5. */
export async function uuid5(name: string, namespace = NAMESPACE_DNS): Promise<string> {
  const ns = Uint8Array.from(namespace.replace(/-/g, "").match(/../g) ?? [], (h) => parseInt(h, 16));
  const nameBytes = enc.encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, ns.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  return formatUuid(stamp(digest.slice(0, 16), 5));
}

/** A deterministic, v4-shaped UUID derived from any key (same key, same UUID). */
export async function uuid4From(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(key)));
  return formatUuid(stamp(digest.slice(0, 16), 4));
}

// ------------------------------------------------------------------ misc

/** Run `fn` over items with at most `limit` in flight (keeps Workers subrequests sane). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The supplier-callback pattern from the old bot: authenticate a shared secret
 * (header `X-Supplier-Webhook-Secret` / `X-Webhook-Secret`, or `?token=` /
 * `?secret=`), take only the order reference from the body, and re-read the
 * order from the supplier. The payload is a wake-up signal, never trusted as
 * the outcome. Returns null when the call is not authentic or not usable;
 * throws (retryable) when the supplier cannot be asked right now.
 */
export async function wakeUpWebhook(
  req: Request,
  opts: {
    secret: string | undefined;
    orderRef: (body: Obj) => string | null;
    check: (supplierOrderId: string) => Promise<PurchaseResult>;
  },
): Promise<{ supplierOrderId: string; result: PurchaseResult } | null> {
  if (req.method !== "POST" || !opts.secret) return null;
  const url = new URL(req.url);
  const provided =
    req.headers.get("x-supplier-webhook-secret") ??
    req.headers.get("x-webhook-secret") ??
    url.searchParams.get("token") ??
    url.searchParams.get("secret") ??
    "";
  if (!(await secretEquals(provided.trim(), opts.secret))) return null;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  if (!isObj(body)) return null;
  const supplierOrderId = opts.orderRef(body);
  if (!supplierOrderId) return null;
  return { supplierOrderId, result: await opts.check(supplierOrderId) };
}

/** Field names that may carry a credential: never shown, whatever the supplier sends. */
const SECRETISH = /key|token|secret|pass|hash|sign|auth|session|cookie|otp|pin/i;

/**
 * Plain facts from a supplier's account answer (name, email, status, rating...)
 * for Admin → Settings → APIs: strings, numbers and booleans, one level deep,
 * never a field whose name looks like a credential.
 */
export function accountFacts(raw: unknown, skip: string[] = []): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const walk = (o: Obj, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (out.length >= 24) return;
      if (SECRETISH.test(k) || skip.includes(k) || v === null || v === undefined || v === "") continue;
      const words = `${prefix} ${k}`.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
      const label = words.charAt(0).toUpperCase() + words.slice(1);
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.push({ label, value: String(v).slice(0, 160) });
      else if (isObj(v) && depth < 1) walk(v, `${prefix} ${k}`.trim(), depth + 1);
    }
  };
  if (isObj(raw)) walk(raw, "", 0);
  return out;
}
