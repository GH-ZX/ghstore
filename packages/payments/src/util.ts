/**
 * Small helpers shared by the payment adapters.
 *
 * Web-standard APIs only (fetch via ctx.fetch, crypto.subtle, TextEncoder), so
 * everything here runs unchanged on Cloudflare Workers, Bun and Node 20+.
 * Nothing here logs. Error messages never carry a secret: request URLs are not
 * repeated (the Telegram one contains the bot token, an RPC URL may contain a
 * key) and provider text is passed through `redact` before it is quoted.
 */
import { AdapterError, type AdapterContext } from "../../core/src/adapters";

// ---------------------------------------------------------------- config

/** A trimmed config value, or undefined when missing or blank. */
export function readConfig(ctx: AdapterContext, key: string): string | undefined {
  const value = ctx.config[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requireConfig(ctx: AdapterContext, adapter: string, key: string): string {
  const value = readConfig(ctx, key);
  if (value === undefined) throw new AdapterError(adapter, `${key} is not configured`);
  return value;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** A positive decimal number from config. A malformed value is an error, never silently ignored. */
export function readPositiveNumber(ctx: AdapterContext, adapter: string, key: string): number | undefined {
  const raw = readConfig(ctx, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!DECIMAL.test(raw) || !Number.isFinite(value) || value <= 0) {
    throw new AdapterError(adapter, `${key} must be a positive number`);
  }
  return value;
}

export function readInteger(
  ctx: AdapterContext,
  adapter: string,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readConfig(ctx, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AdapterError(adapter, `${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readBoolean(ctx: AdapterContext, adapter: string, key: string): boolean | undefined {
  const raw = readConfig(ctx, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new AdapterError(adapter, `${key} must be true or false`);
}

export function nowOf(ctx: AdapterContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- values

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty trimmed string; numbers are accepted and stringified (ids often arrive as numbers). */
export function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberToPlain(value: number): string {
  const s = String(value);
  if (!/e/i.test(s)) return s;
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

/**
 * Parse a non-negative decimal (string or JSON number) exactly into an integer
 * scaled by 10^scale, truncating any further digits. Returns null on anything
 * else, including negatives.
 */
export function parseScaled(value: unknown, scale: number): bigint | null {
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    s = numberToPlain(value);
  } else if (typeof value === "string") {
    s = value.trim();
  } else {
    return null;
  }
  const match = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const frac = ((match[2] ?? "") + "0".repeat(scale)).slice(0, scale);
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac.length > 0 ? frac : "0");
}

/** Integer division rounding up, for non-negative bigints. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Byte length of a string in UTF-8. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------- crypto

/** Constant-time byte comparison. Lengths are compared first; callers hash secrets so length leaks nothing. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Compare two secrets in constant time. Both sides are hashed with SHA-256 first,
 * so neither the content nor the length of the expected value leaks through timing.
 */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function hmacHex(hash: "SHA-256" | "SHA-512", secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(signature));
}

// ---------------------------------------------------------------- http

export interface HttpResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
}

export interface HttpRequest {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  /** Serialized as JSON when present. */
  body?: unknown;
  timeoutMs?: number;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * One HTTP exchange with JSON in and out. A network failure becomes a retryable
 * AdapterError whose message does not repeat the URL or the runtime's own text
 * (either can contain a secret).
 */
export async function httpJson(ctx: AdapterContext, adapter: string, url: string, req: HttpRequest): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.body);
  }
  let res: Response;
  try {
    res = await ctx.fetch(url, { method: req.method, headers, body, signal: timeoutSignal(req.timeoutMs ?? 15_000) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new AdapterError(adapter, timedOut ? "request timed out" : "network error", true);
  }
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    raw = "";
  }
  let json: unknown = null;
  if (raw.length > 0) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  return { status: res.status, ok: res.ok, json };
}

/** Whether an HTTP status is worth asking again (overload or server trouble). */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Remove every given secret from a provider-supplied string before it is quoted in an error. */
export function redact(value: string, secrets: Array<string | undefined>): string {
  let out = value;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** The human-readable message a provider put in an error body, if any. */
export function providerMessage(json: unknown): string | null {
  if (!isRecord(json)) return null;
  for (const key of ["message", "description", "error", "detail"]) {
    const value = json[key];
    if (typeof value === "string" && value.trim().length > 0) return truncate(value.trim(), 200);
  }
  return null;
}

/** Run a read up to `attempts` times, retrying only retryable AdapterErrors, with linear backoff. */
export async function withRetry<T>(attempts: number, baseDelayMs: number, run: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      const retryable = error instanceof AdapterError && error.retryable;
      if (!retryable || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw last;
}
