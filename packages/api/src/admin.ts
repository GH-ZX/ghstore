/**
 * Admin API. Every handler checks the staff role and every change is written to
 * app.audit_log. `support` can review top-ups and handle orders; only `owner`
 * can change settings, balances and roles.
 */
import { requireStaff } from "./auth";
import { EMAIL_FROM, sendTestEmail } from "./email";
import { TIME_ZONE } from "./reports";
import { CHANNEL_URL, EMAIL, TELEGRAM_USERNAME, WHATSAPP_NUMBER } from "./settings";
import type { Ctx } from "./context";
import { call, n, one } from "./db";
import { fulfilOrder } from "./fulfilment";
import { ApiError, int, json, readJson, str, uuid } from "./http";
import { settlePayment } from "./payments";
import { syncSupplier } from "./sync";

async function audit(ctx: Ctx, actor: string, action: string, targetType: string, targetId: string, data: Record<string, unknown> = {}) {
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, $2, $3, $4, $5::text::jsonb)`,
    [actor, action, targetType, targetId, JSON.stringify(data)],
  );
}

export async function overview(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "monitor");
  const db = ctx.svc.db;
  const today = await one<Record<string, string | number>>(
    db,
    // "Today" starts at midnight in the store's time zone.
    `with d as (select date_trunc('day', now() at time zone $1::text) at time zone $1::text as start)
     select
       (select coalesce(sum(total_cents), 0) from app.orders where status = 'delivered' and created_at >= (select start from d)) as sales_today,
       -- Profit after supplier cost and the invite rewards paid today.
       (select coalesce(sum(total_cents - coalesce(cost_cents, total_cents)), 0) from app.orders where status = 'delivered' and created_at >= (select start from d))
         - (select coalesce(sum(amount_cents), 0) from app.ledger where kind = 'referral' and created_at >= (select start from d)) as profit_today,
       (select count(*) from app.orders where created_at >= (select start from d)) as orders_today,
       (select count(*) from app.orders where status in ('paid','processing')) as orders_open,
       (select count(*) from app.orders where status = 'failed') as orders_failed,
       (select count(*) from app.payments where status = 'review') as payments_review,
       (select coalesce(sum(balance_cents), 0) from app.wallets) as wallets_total,
       (select count(*) from app.users where created_at >= (select start from d)) as new_users_today`,
    [TIME_ZONE],
  );
  const suppliers = await db.query<{ id: string; name: string; enabled: boolean; balance_cents: string | number | null; low_balance_cents: string | number; health: string; last_error: string | null }>(
    `select id, name, enabled, balance_cents, low_balance_cents, health, last_error from app.suppliers order by id`,
  );
  const jobs = await db.query(`select name, last_ok_at, last_error from app.job_heartbeats order by name`);
  const t = today ?? {};
  return json({
    salesTodayCents: n(t.sales_today), profitTodayCents: n(t.profit_today), ordersToday: n(t.orders_today),
    ordersOpen: n(t.orders_open), ordersFailed: n(t.orders_failed), paymentsToReview: n(t.payments_review),
    walletsTotalCents: n(t.wallets_total), newUsersToday: n(t.new_users_today),
    suppliers: suppliers.map((s) => ({
      id: s.id, name: s.name, enabled: s.enabled, balanceCents: s.balance_cents === null ? null : n(s.balance_cents),
      low: s.balance_cents !== null && n(s.balance_cents) < n(s.low_balance_cents), health: s.health, lastError: s.last_error,
    })),
    jobs,
  });
}

export async function listPayments(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "monitor");
  const status = ctx.url.searchParams.get("status") ?? "review";
  if (!["created", "pending", "review", "paid", "partial", "failed", "expired", "rejected"].includes(status)) throw new ApiError("invalid_input", "status");
  const rows = await ctx.svc.db.query<{ id: string; user_id: string; display_name: string; method: string; amount_cents: string | number; status: string; tx_hash: string | null; provider_ref: string | null; note: string | null; created_at: string }>(
    `select p.id, p.user_id, u.display_name, p.method, p.amount_cents, p.status, p.tx_hash, p.provider_ref, p.note, p.created_at
       from app.payments p join app.users u on u.id = p.user_id
      where p.status = $1 order by p.created_at desc limit 100`,
    [status],
  );
  return json({ payments: rows.map((r) => ({ ...r, amount_cents: undefined, amountCents: n(r.amount_cents) })) });
}

/** Approve a top-up under review, crediting the amount the staff member confirms they received. */
export async function approvePayment(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx);
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const amountCents = int(body, "amountCents", 1, 1_000_000);
  const note = str(body, "note", { min: 3, max: 300 });
  const rows = await call<{ credited: boolean; balance_cents: string | number }>(
    ctx.svc.db, `select * from app.credit_payment($1, $2, null, null, $3)`, [id, amountCents, staff.id],
  );
  await audit(ctx, staff.id, "payment.approve", "payment", id, { amountCents, note });
  return json({ credited: rows[0]?.credited ?? false, balanceCents: n(rows[0]?.balance_cents) });
}

export async function rejectPayment(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx);
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const note = str(body, "note", { min: 3, max: 300 });
  const res = await ctx.svc.db.query(`update app.payments set status = 'rejected', note = $2 where id = $1 and status in ('created','pending','review','partial') returning id`, [id, note]);
  if (!res.length) throw new ApiError("bad_state");
  await audit(ctx, staff.id, "payment.reject", "payment", id, { note });
  return json({ ok: true });
}

export async function recheckPayment(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx);
  const id = uuid(ctx.params.id);
  const status = await settlePayment(ctx.svc, id);
  await audit(ctx, staff.id, "payment.recheck", "payment", id, { status });
  return json({ status });
}

export async function listOrders(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "monitor");
  const status = ctx.url.searchParams.get("status");
  const rows = await ctx.svc.db.query(
    `select o.id, o.number, o.status, o.total_cents, o.discount_cents, o.cost_cents, o.channel, o.supplier_id, o.supplier_order_id, o.attempts,
            o.last_error, o.created_at, o.delivered_at, u.display_name, p.name_en as product_en, p.name_ar as product_ar
       from app.orders o join app.users u on u.id = o.user_id join app.products p on p.id = o.product_id
      where ($1::text is null or o.status = $1)
      order by o.number desc limit 100`,
    [status && /^[a-z]+$/.test(status) ? status : null],
  );
  return json({ orders: rows });
}

export async function refundOrder(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx);
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const note = str(body, "note", { min: 3, max: 300 });
  const rows = await call<{ refunded: boolean; balance_cents: string | number }>(ctx.svc.db, `select * from app.refund_order($1, $2, $3)`, [id, note, staff.id]);
  await audit(ctx, staff.id, "order.refund", "order", id, { note });
  return json({ refunded: rows[0]?.refunded ?? false });
}

export async function retryOrder(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx);
  const id = uuid(ctx.params.id);
  await ctx.svc.db.query(`update app.orders set next_check_at = now() where id = $1 and status in ('paid','processing')`, [id]);
  const result = await fulfilOrder(ctx.svc, ctx.env, id);
  await audit(ctx, staff.id, "order.retry", "order", id, { result });
  return json({ result });
}

/**
 * Settings the admin may change, with a validator each. Unknown keys are refused.
 * Provider settings (rates, confirmations, keys) are Worker vars/secrets, not here.
 */
const SETTINGS: Record<string, (v: unknown) => boolean> = {
  "theme.preset": (v) => typeof v === "string" && ["calm", "energetic", "minimal", "warm"].includes(v),
  "theme.default_mode": (v) => typeof v === "string" && ["system", "light", "dark"].includes(v),
  "fx.syp_per_usd": (v) => v === null || (typeof v === "number" && v > 0 && v < 1000),
  "orders.max_pending_hours": (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 168,
  "referral.enabled": (v) => typeof v === "boolean",
  "referral.percent": (v) => typeof v === "number" && v >= 0 && v <= 20 && Math.abs(Math.round(v * 100) - v * 100) < 1e-9,
  "referral.days": (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3650,
  "reports.daily": (v) => typeof v === "boolean",
  // Support contacts customers see in the app and the bot (null hides one).
  "support.telegram": (v) => v === null || (typeof v === "string" && TELEGRAM_USERNAME.test(v)),
  "support.whatsapp": (v) => v === null || (typeof v === "string" && WHATSAPP_NUMBER.test(v)),
  "support.email": (v) => v === null || (typeof v === "string" && v.length <= 120 && EMAIL.test(v)),
  // Telegram Stars charged per US dollar of balance (null = Stars top-ups off).
  "payments.stars_per_usd": (v) => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000),
  "reports.daily_hour": (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23,
  // The store's Telegram channel (null = none). The bot's own username is learned from Telegram, not typed.
  "telegram.channel_url": (v) => v === null || (typeof v === "string" && CHANNEL_URL.test(v)),
  "telegram.bot_username": () => false,
  // Tell owners and support staff about each new order.
  "notify.new_orders": (v) => typeof v === "boolean",
  "login.email": (v) => typeof v === "boolean",
  "email.receipts": (v) => typeof v === "boolean",
  "email.from": (v) => v === null || (typeof v === "string" && EMAIL_FROM.test(v)),
  "login.google": (v) => typeof v === "boolean",
};

export async function getSettings(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "monitor");
  const rows = await ctx.svc.db.query<{ key: string; value: unknown }>(`select key, value from app.settings where key = any(string_to_array($1::text, ','))`, [Object.keys(SETTINGS).join(",")]);
  return json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
}

export async function putSetting(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const key = ctx.params.key ?? "";
  const check = SETTINGS[key];
  if (!check) throw new ApiError("not_found");
  const body = await readJson(ctx.req);
  if (!("value" in body) || !check(body.value)) throw new ApiError("invalid_input", "value");
  const before = await one<{ value: unknown }>(ctx.svc.db, `select value from app.settings where key = $1`, [key]);
  await ctx.svc.db.query(
    `insert into app.settings (key, value, updated_by, updated_at) values ($1, $2::text::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(body.value), staff.id],
  );
  await audit(ctx, staff.id, "setting.update", "setting", key, { before: before?.value ?? null, after: body.value });
  return json({ key, value: body.value });
}

export async function adjustWallet(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const userId = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const amountCents = int(body, "amountCents", -1_000_000, 1_000_000);
  const note = str(body, "note", { min: 3, max: 300 });
  const key = uuid(str(body, "idempotencyKey", { max: 36 }), "idempotencyKey");
  const rows = await call<{ applied: boolean; balance_cents: string | number }>(
    ctx.svc.db, `select * from app.adjust_wallet($1, $2, $3, $4, $5)`, [userId, amountCents, note, staff.id, key],
  );
  return json({ applied: rows[0]?.applied ?? false, balanceCents: n(rows[0]?.balance_cents) });
}

export async function setUserRole(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const userId = uuid(ctx.params.id);
  if (userId === staff.id) throw new ApiError("not_allowed");
  const body = await readJson(ctx.req);
  const role = str(body, "role", { max: 10 });
  const status = body.status === undefined ? undefined : str(body, "status", { max: 10 });
  if (!["customer", "monitor", "support", "owner"].includes(role)) throw new ApiError("invalid_input", "role");
  if (status !== undefined && !["active", "banned"].includes(status)) throw new ApiError("invalid_input", "status");
  await ctx.svc.db.query(
    `update app.users set role = $2, status = coalesce($3, status),
            sessions_revoked_at = case when $3 = 'banned' or $2 <> role then now() else sessions_revoked_at end
      where id = $1`,
    [userId, role, status ?? null],
  );
  await audit(ctx, staff.id, "user.update", "user", userId, { role, status });
  return json({ ok: true });
}

export async function runSupplierSync(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = ctx.params.id ?? "";
  if (!/^[a-z0-9_]{2,32}$/.test(id)) throw new ApiError("not_found");
  const report = await syncSupplier(ctx.svc, id);
  await audit(ctx, staff.id, "supplier.sync", "supplier", id, { ...report });
  return json(report);
}

/** Find customers by name, Telegram username or id, email, or user id. */
export async function listUsers(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "monitor");
  const q = (ctx.url.searchParams.get("q") ?? "").trim().replace(/^@/, "").slice(0, 80);
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const rows = await ctx.svc.db.query<{
    id: string; display_name: string; role: string; status: string; created_at: string; last_seen_at: string | null;
    balance_cents: string | number; telegram: string | null; tg_id: string | null; email: string | null; orders: string | number;
  }>(
    `select u.id, u.display_name, u.role, u.status, u.created_at, u.last_seen_at, w.balance_cents,
            t.username as telegram, t.subject as tg_id, e.email,
            (select count(*) from app.orders o where o.user_id = u.id) as orders
       from app.users u
       join app.wallets w on w.user_id = u.id
       left join app.identities t on t.user_id = u.id and t.provider = 'telegram'
       left join app.identities e on e.user_id = u.id and e.provider = 'supabase'
      where $1 = '' or u.display_name ilike $2 or t.username ilike $2 or t.subject = $1 or e.email ilike $2 or u.id::text = $1
      order by u.last_seen_at desc nulls last limit 50`,
    [q, like],
  );
  return json({
    users: rows.map((r) => ({
      id: r.id, name: r.display_name, role: r.role, status: r.status, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
      balanceCents: n(r.balance_cents), telegramUsername: r.telegram, telegramId: r.tg_id, email: r.email, orders: n(r.orders),
    })),
  });
}

/** Admin → Settings → Email receipts → "Send me a test": a sample receipt to the owner's linked email. */
export async function testEmail(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  try {
    const to = await sendTestEmail(ctx.svc, ctx.env, staff.id, staff.locale);
    return json({ ok: true, to });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Resend refused (wrong key, unverified domain...): say why, without any secret.
    const msg = err instanceof Error ? err.message.slice(0, 200) : "error";
    return json({ error: { code: "bad_state", field: msg } }, { status: 409 });
  }
}
