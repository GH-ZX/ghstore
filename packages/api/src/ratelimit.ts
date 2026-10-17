/**
 * Throttles: a counter per key and fixed time window in app.rate_limits
 * (migration 0032), counted and checked in one SQL call. Expired windows are
 * cleared by the same function now and then, so nothing else has to.
 *
 * A fixed window lets a burst of up to twice the limit through around a window
 * boundary; that is fine for what these guard (sign-in floods, coupon-code
 * guessing, report spam).
 */
import type { Ctx } from "./context";
import type { Db } from "./db";
import { ApiError } from "./http";

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowSeconds: number;
}

/** The limits in one place, so they are easy to find and tune. */
export const LIMITS = {
  /** Sign-in attempts from one address (shared mobile networks put many customers behind one). */
  loginPerIp: { max: 100, windowSeconds: 600 },
  /** Sign-ins of one Telegram or website account. */
  loginPerIdentity: { max: 30, windowSeconds: 600 },
  /** Coupon quotes per customer: enough to try a few codes, not to guess them. */
  couponQuote: { max: 20, windowSeconds: 600 },
  /** Problem reports per customer (one open report per order is enforced separately). */
  problemReport: { max: 10, windowSeconds: 3600 },
  /** Review saves (writes and edits) per customer. */
  reviewSave: { max: 20, windowSeconds: 3600 },
} satisfies Record<string, Limit>;

/** Count one request against `key`; true while it is within the limit. */
export async function hit(db: Db, key: string, limit: Limit): Promise<boolean> {
  const rows = await db.query<{ ok: boolean }>(`select app.rate_limit_hit($1, $2, $3) as ok`, [key.slice(0, 200), limit.max, limit.windowSeconds]);
  return rows[0]?.ok === true;
}

/** Count one request against `key`, answering 429 rate_limited once over the limit. */
export async function throttle(db: Db, key: string, limit: Limit): Promise<void> {
  if (!(await hit(db, key, limit))) throw new ApiError("rate_limited");
}

/**
 * The caller's address, from Cloudflare's CF-Connecting-IP (set by Cloudflare,
 * not by the client). IPv6 addresses are reduced to their /64, which one
 * subscriber usually holds whole. Null when absent or unreadable (local runs,
 * tests): the per-address limit is then skipped, the per-account one still applies.
 */
export function clientIp(req: Request): string | null {
  const raw = req.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!raw || raw.length > 64) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  if (!/^[0-9a-fA-F:.]+$/.test(raw) || !raw.includes(":")) return null;
  return ipv6Prefix64(raw);
}

/** The first four groups of an IPv6 address, written out ("2001:db8:0:0"). */
export function ipv6Prefix64(addr: string): string | null {
  const parts = addr.toLowerCase().split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const groups = (g: string[]) => g.reduce((n, x) => n + (x.includes(".") ? 2 : 1), 0);
  const missing = parts.length === 2 ? 8 - groups(head) - groups(tail) : 0;
  if (missing < 0) return null;
  const full = [...head, ...Array<string>(missing).fill("0"), ...tail];
  const first = full.slice(0, 4);
  if (first.length < 4 || first.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return first.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

/** Sign-in throttle by address, before any work (signature checks, Supabase calls). */
export async function throttleLoginIp(ctx: Ctx): Promise<void> {
  const ip = clientIp(ctx.req);
  if (ip) await throttle(ctx.svc.db, `login:ip:${ip}`, LIMITS.loginPerIp);
}

/** Sign-in throttle by account, once the login is verified (`kind` "tg" or "web"). */
export async function throttleLoginIdentity(ctx: Ctx, kind: "tg" | "web", subject: string): Promise<void> {
  await throttle(ctx.svc.db, `login:${kind}:${subject}`, LIMITS.loginPerIdentity);
}
