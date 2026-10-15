/**
 * The database interface the API needs. Production uses node-postgres through
 * Cloudflare Hyperdrive (apps/web/src/services.ts); tests use postgres.js or Bun.SQL.
 * Queries always use $1-style parameters, never string interpolation.
 * JSON goes in as text and is cast in SQL (`$1::text::jsonb`): drivers disagree
 * on how they encode a JS string bound to a jsonb parameter.
 */
import { ApiError, type ErrorCode } from "./http";

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run fn in a transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export async function one<T>(db: Db, text: string, params?: readonly unknown[]): Promise<T | undefined> {
  const rows = await db.query<T>(text, params);
  return rows[0];
}

export async function must<T>(db: Db, text: string, params?: readonly unknown[], code: ErrorCode = "not_found"): Promise<T> {
  const row = await one<T>(db, text, params);
  if (!row) throw new ApiError(code);
  return row;
}

/** Messages raised by the SQL functions (see packages/db/migrations/0002 and 0004). */
const DB_CODES = new Set<ErrorCode>([
  "insufficient_balance",
  "offer_unavailable",
  "out_of_stock",
  "user_blocked",
  "invalid_quantity",
  "invalid_input",
  "payment_not_found",
  "tx_reused",
  "bad_state",
  "not_allowed",
  "coupon_invalid",
  "coupon_not_applicable",
  "coupon_used",
  "coupon_exhausted",
  "coupon_min_order",
]);

/** SQLSTATE 23505 (unique violation): `code` in node-postgres/postgres.js, `errno` in Bun.SQL. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown } | null;
  return e?.code === "23505" || e?.errno === "23505";
}

/** Turn a known database exception into an ApiError; rethrow anything else. */
export function mapDbError(err: unknown): never {
  const msg = (err as { message?: unknown })?.message;
  if (typeof msg === "string" && DB_CODES.has(msg as ErrorCode)) throw new ApiError(msg as ErrorCode);
  if (isUniqueViolation(err)) throw new ApiError("conflict");
  throw err;
}

/** Call a SQL function and map its business errors. */
export async function call<T>(db: Db, text: string, params: readonly unknown[]): Promise<T[]> {
  try {
    return await db.query<T>(text, params);
  } catch (err) {
    mapDbError(err);
  }
}

/** Postgres bigint columns may arrive as strings; amounts here always fit in a JS number. */
export function n(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  if (value === null || value === undefined) return 0;
  throw new TypeError(`not an integer: ${String(value)}`);
}
