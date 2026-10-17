/**
 * Reading admin request bodies (optional fields: absent leaves a column as it
 * is) and the generic row update the admin screens share.
 */
import type { Ctx } from "./context";
import { call } from "./db";
import { ApiError, int } from "./http";

export function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ApiError("invalid_input", key);
  return v;
}

export function optInt(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  return body[key] === undefined || body[key] === null ? undefined : int(body, key, min, max);
}

export function optNum(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ApiError("invalid_input", key);
  return Math.round(v * 100) / 100;
}

/** Build `update ... set a = $2, b = $3` from a column map. Column names come from our own lists only. */
export async function updateRow(ctx: Ctx, table: string, id: string, changes: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(changes);
  if (!cols.length) throw new ApiError("bad_request");
  const isJson = (c: string) => c === "input_fields" || c === "after_fields";
  const sets = cols.map((c, i) => (isJson(c) ? `${c} = $${i + 2}::text::jsonb` : `${c} = $${i + 2}`));
  const params = cols.map((c) => (isJson(c) ? JSON.stringify(changes[c]) : changes[c]));
  const rows = await call(ctx.svc.db, `update app.${table} set ${sets.join(", ")} where id = $1 returning id`, [id, ...params]);
  if (!rows.length) throw new ApiError("not_found");
}
