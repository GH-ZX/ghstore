/**
 * Loyalty levels: what a customer spent on delivered orders in the last 30 days
 * sets their level (Admin → Settings → Loyalty levels: ascending thresholds,
 * each with a percent), and every delivered order pays that percent back to
 * their wallet. The paying is done by the database (app.pay_cashback, migration
 * 0029), never more than the order's margin; this file shows the level.
 */
import { requireUser } from "./auth";
import type { Ctx } from "./context";
import { n, one, type Db } from "./db";
import { json } from "./http";
import { readSettings } from "./settings";

export interface Tier {
  minCents: number;
  percent: number;
}

export const DEFAULT_TIERS: Tier[] = [
  { minCents: 5000, percent: 1 },
  { minCents: 20000, percent: 2 },
  { minCents: 50000, percent: 3 },
];

/** The tiers as stored ({ min_cents, percent }), checked: 1 to 5, ascending, 0–10 %. */
export function validTiers(v: unknown): boolean {
  if (!Array.isArray(v) || v.length < 1 || v.length > 5) return false;
  let last = -1;
  for (const t of v) {
    if (!t || typeof t !== "object") return false;
    const min = (t as Record<string, unknown>).min_cents;
    const pct = (t as Record<string, unknown>).percent;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min > 10_000_000 || min <= last) return false;
    if (typeof pct !== "number" || pct < 0 || pct > 10 || Math.round(pct * 100) !== pct * 100) return false;
    last = min;
  }
  return true;
}

export async function loyaltySettings(db: Db): Promise<{ enabled: boolean; tiers: Tier[] }> {
  const s = await readSettings(db, ["loyalty.enabled", "loyalty.tiers"]);
  const raw = s["loyalty.tiers"];
  const tiers = validTiers(raw)
    ? (raw as { min_cents: number; percent: number }[]).map((t) => ({ minCents: t.min_cents, percent: t.percent }))
    : DEFAULT_TIERS;
  return { enabled: s["loyalty.enabled"] === true, tiers };
}

/** GET /api/me/level — the customer's level, what they spent, and the next level. */
export async function myLevel(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const { enabled, tiers } = await loyaltySettings(ctx.svc.db);
  if (!enabled) return json({ enabled: false });
  const spent = n((await one<{ spent: string | number }>(ctx.svc.db, `select app.loyalty_spent($1) as spent`, [user.id]))?.spent);
  let level = 0;
  tiers.forEach((t, i) => {
    if (spent >= t.minCents) level = i + 1;
  });
  const next = tiers[level] ?? null;
  return json({
    enabled: true,
    level,
    percent: level ? tiers[level - 1]!.percent : 0,
    spentCents: spent,
    tiers,
    next: next ? { level: level + 1, minCents: next.minCents, percent: next.percent, leftCents: next.minCents - spent } : null,
  });
}
