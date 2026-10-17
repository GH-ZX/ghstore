/**
 * Loyalty levels: what a customer spent on delivered orders in the last 30 days
 * sets their level (Admin → Settings → Loyalty levels: ascending thresholds,
 * each with a percent), and every delivered order pays that percent back to
 * their wallet. The paying is done by the database (app.pay_cashback, migration
 * 0029), never more than the order's margin; this file shows the level.
 */
import type { Ctx } from "./context";
import { n, one, type Db } from "./db";
import { requireUser } from "./guard";
import { json } from "./http";
import { readSettings } from "./settings";
import { settingValue } from "./settings-registry";

export interface Tier {
  minCents: number;
  percent: number;
}

export async function loyaltySettings(db: Db): Promise<{ enabled: boolean; tiers: Tier[] }> {
  const s = await readSettings(db, ["loyalty.enabled", "loyalty.tiers"]);
  const tiers = settingValue(s, "loyalty.tiers").map((t) => ({ minCents: t.min_cents, percent: t.percent }));
  return { enabled: settingValue(s, "loyalty.enabled"), tiers };
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
