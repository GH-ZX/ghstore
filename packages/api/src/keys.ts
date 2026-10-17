/**
 * Payment and supplier keys set by the owner in Admin → Settings → Keys
 * (app.store_keys), on top of the Worker's own secrets.
 *
 * - Only the names below can be set. The store bot token, DATA_KEY, SESSION_SECRET,
 *   TELEGRAM_WEBHOOK_SECRET and the SAM and supplier webhook secrets stay Worker
 *   secrets: the store cannot sign anyone in, or read these values, without them.
 *   NOWPAYMENTS_IPN_SECRET is the exception: it can be set here too, so an owner
 *   with Admin → Keys can change how NOWPayments callbacks are checked (they are
 *   still only wake-ups: the payment is re-read from NOWPayments before crediting).
 * - Values are AES-GCM encrypted with DATA_KEY, bound to their name, and never
 *   sent back to the browser; the admin sees only whether a key is set and its
 *   last four characters.
 * - A key set in the admin wins over a Worker secret of the same name.
 */
import { decryptText, encryptText } from "@store/core";
import { audit } from "./audit";
import { requireStaff } from "./auth";
import type { ApiEnv, Ctx } from "./context";
import type { Db } from "./db";
import { ApiError, json, readJson } from "./http";

export interface KeySpec {
  name: string;
  group: "payments" | "suppliers" | "telegram" | "email" | "storage";
  /** What it is for, shown in the admin. */
  label: string;
  pattern: RegExp;
}

const API_KEY = /^[\x21-\x7e]{8,500}$/; // printable, no spaces

export const STORE_KEYS: KeySpec[] = [
  { name: "SAM_API_KEY", group: "payments", label: "ShamCash (SAM) API key", pattern: API_KEY },
  { name: "SAM_WALLET", group: "payments", label: "ShamCash receiving wallet (optional)", pattern: /^[\x21-\x7e]{4,120}$/ },
  { name: "NOWPAYMENTS_API_KEY", group: "payments", label: "NOWPayments API key", pattern: API_KEY },
  { name: "NOWPAYMENTS_IPN_SECRET", group: "payments", label: "NOWPayments IPN secret", pattern: API_KEY },
  { name: "BEP20_ADDRESS", group: "payments", label: "USDT (BEP20) receiving address", pattern: /^0x[0-9a-fA-F]{40}$/ },
  // Finding USDT top-ups by amount reads the address's transfers (eth_getLogs). The free
  // public server is used by default; a private one (its URL often holds a key) if it refuses.
  { name: "BSC_LOGS_RPC_URL", group: "payments", label: "USDT (BEP20) log server URL (optional)", pattern: /^https:\/\/[\x21-\x7e]{8,500}$/ },
  { name: "G2BULK_API_KEY", group: "suppliers", label: "G2Bulk", pattern: API_KEY },
  { name: "BATSTORE_API_KEY", group: "suppliers", label: "BatStore", pattern: API_KEY },
  { name: "MAXSTORE_API_KEY", group: "suppliers", label: "MaxStore", pattern: API_KEY },
  { name: "PRODSELLER_API_KEY", group: "suppliers", label: "ProdSeller", pattern: API_KEY },
  { name: "FIVESIM_API_KEY", group: "suppliers", label: "5SIM", pattern: API_KEY },
  // Optional second bot that sends staff alerts (new orders, stuck orders, daily summary).
  // A wrong value only affects those alerts, so unlike the store bot it can live here.
  { name: "NOTIFY_BOT_TOKEN", group: "telegram", label: "Staff alerts bot token (optional)", pattern: /^[0-9]{5,15}:[A-Za-z0-9_-]{30,60}$/ },
  // Email receipts (Admin → Settings → Email receipts), sent with Resend.
  { name: "RESEND_API_KEY", group: "email", label: "Resend API key", pattern: /^re_[A-Za-z0-9_]{10,200}$/ },
  // Store pictures (uploads, and copies of linked pictures) in Supabase Storage: the project's
  // secret key (sb_secret_…, or the legacy service_role key). It can write to the bucket.
  { name: "SUPABASE_SECRET_KEY", group: "storage", label: "Supabase secret key (pictures)", pattern: /^(sb_secret_[A-Za-z0-9_-]{10,200}|eyJ[A-Za-z0-9_.-]{40,2000})$/ },
];
const SPEC = new Map(STORE_KEYS.map((k) => [k.name, k]));

/** The value is sealed together with its name, so one key can't be swapped for another in the database. */
const seal = (name: string, value: string) => `${name}\n${value}`;

/** Keys read in the last minute, per Worker instance (a change in the admin clears it at once there). */
let cache: { at: number; values: Record<string, string> } | null = null;
const CACHE_MS = 60_000;

export function clearStoreKeysCache(): void {
  cache = null;
}

/** All keys set in the admin, decrypted. A value that does not decrypt is skipped (and logged), never fatal. */
export async function loadStoreKeys(db: Db, dataKey: string, now = Date.now()): Promise<Record<string, string>> {
  if (cache && now - cache.at < CACHE_MS) return cache.values;
  const rows = await db.query<{ name: string; value_enc: string }>(`select name, value_enc from app.store_keys`);
  const values: Record<string, string> = {};
  for (const r of rows) {
    if (!SPEC.has(r.name)) continue;
    try {
      const plain = await decryptText(r.value_enc, dataKey);
      const prefix = `${r.name}\n`;
      if (plain.startsWith(prefix)) values[r.name] = plain.slice(prefix.length);
      else console.error(`store key ${r.name}: sealed for another name, ignored`);
    } catch {
      console.error(`store key ${r.name}: cannot be decrypted with this DATA_KEY, ignored`);
    }
  }
  cache = { at: now, values };
  return values;
}

/** The Worker's settings with the admin's keys on top. */
export async function effectiveEnv(env: ApiEnv, db: Db): Promise<ApiEnv> {
  const keys = await loadStoreKeys(db, env.DATA_KEY);
  return Object.keys(keys).length ? { ...env, ...keys } : env;
}

/** Owner only: which keys are set, where, and their last four characters. Never the values. */
export async function listKeys(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const rows = await ctx.svc.db.query<{ name: string; hint: string | null; updated_at: string | Date }>(
    `select name, hint, updated_at from app.store_keys`,
  );
  const inAdmin = new Map(rows.map((r) => [r.name, r]));
  return json({
    keys: STORE_KEYS.map((k) => {
      const row = inAdmin.get(k.name);
      const fromWorker = typeof ctx.env[k.name] === "string" && (ctx.env[k.name] as string).trim() !== "";
      return {
        name: k.name,
        group: k.group,
        label: k.label,
        source: row ? "admin" : fromWorker ? "worker" : null,
        hint: row?.hint ?? null,
        updatedAt: row ? new Date(row.updated_at).toISOString() : null,
      };
    }),
  });
}

/** Owner only: set a key ({ value }) or remove it ({ value: null }). The value never appears in the audit log. */
export async function putKey(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const name = ctx.params.name ?? "";
  const spec = SPEC.get(name);
  if (!spec) throw new ApiError("not_found");
  const body = await readJson(ctx.req);
  if (!("value" in body)) throw new ApiError("invalid_input", "value");
  if (body.value === null || body.value === "") {
    await ctx.svc.db.query(`delete from app.store_keys where name = $1`, [name]);
    await audit(ctx.svc.db, { actor: staff.id, action: "key.remove", targetType: "key", targetId: name });
  } else {
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (!spec.pattern.test(value)) throw new ApiError("invalid_input", "value");
    const hint = value.slice(-4);
    await ctx.svc.db.query(
      `insert into app.store_keys (name, value_enc, hint, updated_at, updated_by) values ($1, $2, $3, now(), $4)
       on conflict (name) do update set value_enc = excluded.value_enc, hint = excluded.hint, updated_at = now(), updated_by = excluded.updated_by`,
      [name, await encryptText(seal(name, value), ctx.env.DATA_KEY), hint, staff.id],
    );
    await audit(ctx.svc.db, { actor: staff.id, action: "key.set", targetType: "key", targetId: name, data: { hint } });
  }
  clearStoreKeysCache();
  return listKeys(ctx);
}
