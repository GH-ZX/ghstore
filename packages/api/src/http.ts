/** HTTP helpers shared by every handler. Web-standard Request/Response only. */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "insufficient_balance"
  | "offer_unavailable"
  | "out_of_stock"
  | "user_blocked"
  | "invalid_quantity"
  | "invalid_input"
  | "payment_not_found"
  | "payment_method_unavailable"
  | "tx_reused"
  | "bad_state"
  | "not_allowed"
  | "coupon_invalid"
  | "coupon_not_applicable"
  | "coupon_used"
  | "coupon_exhausted"
  | "coupon_min_order"
  | "account_in_use"
  | "already_linked"
  | "limit_new_account"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  limit_new_account: 403,
  insufficient_balance: 402,
  offer_unavailable: 409,
  out_of_stock: 409,
  user_blocked: 403,
  invalid_quantity: 400,
  invalid_input: 400,
  payment_not_found: 404,
  payment_method_unavailable: 409,
  tx_reused: 409,
  bad_state: 409,
  not_allowed: 403,
  coupon_invalid: 400,
  coupon_not_applicable: 409,
  coupon_used: 409,
  coupon_exhausted: 409,
  coupon_min_order: 409,
  account_in_use: 409,
  already_linked: 409,
  internal: 500,
};

/** An error that is safe to show to the client: a code plus an optional field name. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly field?: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
  get status(): number {
    return STATUS[this.code];
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, field: err.field } }, { status: err.status });
  }
  // Never leak internals: log server-side, return a generic error.
  console.error("unhandled error", err instanceof Error ? `${err.name}: ${err.message}` : err);
  return json({ error: { code: "internal" } }, { status: 500 });
}

/** Read a JSON object body, refusing anything large or not an object. */
export async function readJson(req: Request, maxBytes = 32_768): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new ApiError("bad_request");
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError("bad_request");
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError("bad_request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("bad_request");
  return body as Record<string, unknown>;
}

// ── tiny validators (no dependencies) ─────────────────────────────────────

export function str(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; pattern?: RegExp } = {}): string {
  const v = body[key];
  if (typeof v !== "string") throw new ApiError("invalid_input", key);
  const s = v.trim();
  if (s.length < (opts.min ?? 1) || s.length > (opts.max ?? 500)) throw new ApiError("invalid_input", key);
  if (opts.pattern && !opts.pattern.test(s)) throw new ApiError("invalid_input", key);
  return s;
}

export function optStr(body: Record<string, unknown>, key: string, opts: { max?: number } = {}): string | undefined {
  if (body[key] === undefined || body[key] === null || body[key] === "") return undefined;
  return str(body, key, { min: 0, max: opts.max ?? 500 });
}

export function int(body: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new ApiError("invalid_input", key);
  return v;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuid(value: string | undefined, field = "id"): string {
  if (!value || !UUID_RE.test(value)) throw new ApiError("invalid_input", field);
  return value;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
