/**
 * Referral rewards and coupon codes. The money rules live in SQL
 * (packages/db/migrations/0004): rewards are paid by a trigger when an invited
 * customer's order is delivered, and coupons are applied inside place_order.
 */
import { audit } from "./audit";
import type { Ctx } from "./context";
import { call, n, one } from "./db";
import { requireStaff, requireUser } from "./guard";
import { ApiError, int, json, readJson, str, uuid } from "./http";
import { LIMITS, throttle } from "./ratelimit";
import { settingValue } from "./settings-registry";

const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const REF_RE = /^[A-Za-z2-9]{6,12}$/;

/** Normalise a typed coupon code, or refuse it as "not a valid code". */
export function couponCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!CODE_RE.test(code)) throw new ApiError("coupon_invalid");
  return code;
}

export interface ReferralSettings {
  enabled: boolean;
  percent: number;
  days: number;
}

export async function referralSettings(ctx: Pick<Ctx, "svc">): Promise<ReferralSettings> {
  const rows = await ctx.svc.db.query<{ key: string; value: unknown }>(
    `select key, value from app.settings where key in ('referral.enabled', 'referral.percent', 'referral.days')`,
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: settingValue(s, "referral.enabled"),
    percent: settingValue(s, "referral.percent"),
    days: settingValue(s, "referral.days"),
  };
}

/** GET /api/me/referral — the customer's invite code and what it has earned. */
export async function getReferral(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const settings = await referralSettings(ctx);
  if (!settings.enabled || settings.percent <= 0) return json({ enabled: false });
  const rows = await call<{ code: string }>(ctx.svc.db, `select app.ensure_referral_code($1) as code`, [user.id]);
  const stats = await one<{ invited: string | number; buyers: string | number; earned: string | number }>(
    ctx.svc.db,
    `select (select count(*) from app.users where referred_by = $1) as invited,
            (select count(distinct o.user_id) from app.orders o join app.users u on u.id = o.user_id
              where u.referred_by = $1 and o.status = 'delivered') as buyers,
            (select coalesce(sum(amount_cents), 0) from app.ledger where user_id = $1 and kind = 'referral') as earned`,
    [user.id],
  );
  return json({
    enabled: true,
    percent: settings.percent,
    days: settings.days,
    code: rows[0]?.code ?? null,
    invited: n(stats?.invited),
    buyers: n(stats?.buyers),
    earnedCents: n(stats?.earned),
  });
}

/** POST /api/me/referral — link a new customer to the friend who invited them. */
export async function claimReferral(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!REF_RE.test(code)) return json({ applied: false });
  const rows = await call<{ applied: boolean }>(ctx.svc.db, `select app.set_referrer($1, $2) as applied`, [user.id, code]);
  return json({ applied: rows[0]?.applied === true });
}

/** POST /api/coupons/quote — what a code takes off before buying. */
export async function quoteCoupon(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  // Every quote counts, good code or not, so codes cannot be guessed by trying them here.
  await throttle(ctx.svc.db, `coupon:${user.id}`, LIMITS.couponQuote);
  const body = await readJson(ctx.req);
  const offerId = uuid(str(body, "offerId", { max: 36 }), "offerId");
  const quantity = body.quantity === undefined ? 1 : int(body, "quantity", 1, 100);
  const code = couponCode(body.code);
  const rows = await call<{ code: string; discount_cents: string | number; total_cents: string | number }>(
    ctx.svc.db,
    `select code, discount_cents, total_cents from app.quote_coupon($1, $2, $3, $4)`,
    [user.id, offerId, quantity, code],
  );
  const r = rows[0];
  if (!r) throw new ApiError("coupon_invalid");
  return json({ code: r.code, discountCents: n(r.discount_cents), totalCents: n(r.total_cents) });
}

// ───────────────────────────────────────────────────────────── admin

interface CouponRow {
  id: string;
  code: string;
  percent_off: string | number | null;
  amount_off_cents: string | number | null;
  max_discount_cents: string | number | null;
  min_order_cents: string | number;
  product_id: string | null;
  product_en: string | null;
  product_ar: string | null;
  max_uses: number | null;
  max_uses_per_user: number;
  uses: number;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  note: string;
  created_at: string;
  discount_total: string | number;
}

function publicCoupon(r: CouponRow) {
  return {
    id: r.id,
    code: r.code,
    percentOff: r.percent_off === null ? null : Number(r.percent_off),
    amountOffCents: r.amount_off_cents === null ? null : n(r.amount_off_cents),
    maxDiscountCents: r.max_discount_cents === null ? null : n(r.max_discount_cents),
    minOrderCents: n(r.min_order_cents),
    productId: r.product_id,
    productEn: r.product_en,
    productAr: r.product_ar,
    maxUses: r.max_uses,
    maxUsesPerUser: r.max_uses_per_user,
    uses: r.uses,
    startsAt: r.starts_at,
    expiresAt: r.expires_at,
    active: r.active,
    note: r.note,
    createdAt: r.created_at,
    discountTotalCents: n(r.discount_total),
  };
}

const COUPON_SELECT = `
  select c.id, c.code, c.percent_off, c.amount_off_cents, c.max_discount_cents, c.min_order_cents, c.product_id,
         p.name_en as product_en, p.name_ar as product_ar, c.max_uses, c.max_uses_per_user, c.uses,
         c.starts_at, c.expires_at, c.active, c.note, c.created_at,
         (select coalesce(sum(r.discount_cents), 0) from app.coupon_redemptions r
           where r.coupon_id = c.id and r.released_at is null) as discount_total
    from app.coupons c left join app.products p on p.id = c.product_id`;

export async function listCoupons(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "monitor");
  const rows = await ctx.svc.db.query<CouponRow>(`${COUPON_SELECT} order by c.active desc, c.created_at desc limit 200`);
  return json({ coupons: rows.map(publicCoupon) });
}

function nullableInt(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
  return body[key] === null ? null : int(body, key, min, max);
}

function nullableDate(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 40) throw new ApiError("invalid_input", key);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ApiError("invalid_input", key);
  return d.toISOString();
}

/** Coupon fields from a request body, as column → value. `partial` allows leaving fields out. */
function couponFields(body: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => k in body && body[k] !== undefined;

  if (has("percentOff") && body.percentOff !== null) {
    const p = body.percentOff;
    if (typeof p !== "number" || !(p > 0 && p <= 100) || Math.abs(Math.round(p * 100) - p * 100) > 1e-9) throw new ApiError("invalid_input", "percentOff");
    out.percent_off = p;
    out.amount_off_cents = null;
  } else if (has("amountOffCents") && body.amountOffCents !== null) {
    out.amount_off_cents = int(body, "amountOffCents", 1, 1_000_000);
    out.percent_off = null;
  } else if (!partial) {
    throw new ApiError("invalid_input", "percentOff");
  }
  if (has("maxDiscountCents")) out.max_discount_cents = nullableInt(body, "maxDiscountCents", 1, 1_000_000);
  if (has("minOrderCents")) out.min_order_cents = int(body, "minOrderCents", 0, 1_000_000);
  if (has("productId")) out.product_id = body.productId === null ? null : uuid(typeof body.productId === "string" ? body.productId : undefined, "productId");
  if (has("maxUses")) out.max_uses = nullableInt(body, "maxUses", 1, 1_000_000);
  if (has("maxUsesPerUser")) out.max_uses_per_user = int(body, "maxUsesPerUser", 1, 1000);
  if (has("startsAt")) out.starts_at = nullableDate(body, "startsAt");
  if (has("expiresAt")) out.expires_at = nullableDate(body, "expiresAt");
  if (has("active")) {
    if (typeof body.active !== "boolean") throw new ApiError("invalid_input", "active");
    out.active = body.active;
  }
  if (has("note")) {
    if (typeof body.note !== "string" || body.note.length > 200) throw new ApiError("invalid_input", "note");
    out.note = body.note.trim();
  }
  if (typeof out.starts_at === "string" && typeof out.expires_at === "string" && out.expires_at <= out.starts_at) {
    throw new ApiError("invalid_input", "expiresAt");
  }
  return out;
}

export async function createCoupon(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req);
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!CODE_RE.test(code)) throw new ApiError("invalid_input", "code");
  const fields = couponFields(body, false);
  const cols = ["code", "created_by", ...Object.keys(fields)];
  const vals = [code, staff.id, ...Object.values(fields)];
  const rows = await call<{ id: string }>(
    ctx.svc.db,
    `insert into app.coupons (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    vals,
  );
  const id = rows[0]?.id;
  if (!id) throw new ApiError("internal");
  await audit(ctx.svc.db, { actor: staff.id, action: "coupon.create", targetType: "coupon", targetId: id, data: { code, ...fields } });
  const row = await one<CouponRow>(ctx.svc.db, `${COUPON_SELECT} where c.id = $1`, [id]);
  return json({ coupon: row ? publicCoupon(row) : null }, { status: 201 });
}

export async function updateCoupon(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const fields = couponFields(body, true);
  const keys = Object.keys(fields);
  if (!keys.length) throw new ApiError("invalid_input");
  // Column names come from couponFields' fixed list, never from the request.
  const rows = await call<{ id: string; starts_at: string | null; expires_at: string | null }>(
    ctx.svc.db,
    `update app.coupons set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1 returning id, starts_at, expires_at`,
    [id, ...Object.values(fields)],
  ).catch((err: unknown) => {
    // A start date after the saved end date (or the reverse) breaks the table check.
    if ((err as { code?: unknown; errno?: unknown })?.code === "23514" || (err as { errno?: unknown })?.errno === "23514") {
      throw new ApiError("invalid_input", "expiresAt");
    }
    throw err;
  });
  if (!rows.length) throw new ApiError("not_found");
  await audit(ctx.svc.db, { actor: staff.id, action: "coupon.update", targetType: "coupon", targetId: id, data: fields });
  const row = await one<CouponRow>(ctx.svc.db, `${COUPON_SELECT} where c.id = $1`, [id]);
  return json({ coupon: row ? publicCoupon(row) : null });
}
