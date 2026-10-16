/**
 * Owner reports: a daily summary on Telegram, and CSV exports of orders,
 * top-ups and wallet history for the accountant or a spreadsheet.
 * Days follow the store's time zone (store.config.ts → timeZone).
 */
import { store } from "@store/config";
import { formatUsd } from "@store/core";
import { requireStaff } from "./auth";
import type { Services } from "./context";
import type { Ctx } from "./context";
import { n, one } from "./db";
import { ApiError } from "./http";

export const TIME_ZONE: string = store.timeZone;

/** The hour (0–23) and date (YYYY-MM-DD) right now in the store's time zone. */
export function localNow(now: Date, timeZone = TIME_ZONE): { hour: number; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { hour: Number(parts.hour) % 24, date: `${parts.year}-${parts.month}-${parts.day}` };
}

export interface DaySummary {
  date: string;
  salesCents: number;
  orders: number;
  profitCents: number;
  rewardsCents: number;
  topupsCents: number;
  topups: number;
  newUsers: number;
  /** Sales the owner made in person (paid by hand), within salesCents. */
  inPersonCents: number;
  inPersonOrders: number;
  failedOrders: number;
  refundedOrders: number;
  openOrders: number;
  toReview: number;
  lowSuppliers: string[];
}

/** Totals for one local day (YYYY-MM-DD). */
export async function daySummary(svc: Pick<Services, "db">, date: string, timeZone = TIME_ZONE): Promise<DaySummary> {
  const r = await one<Record<string, string | number | string[] | null>>(
    svc.db,
    `with bounds as (select ($1::date)::timestamp at time zone $2 as a, ($1::date + 1)::timestamp at time zone $2 as b)
     select
       (select coalesce(sum(total_cents), 0) from app.orders, bounds where status = 'delivered' and created_at >= a and created_at < b) as sales,
       (select count(*) from app.orders, bounds where status = 'delivered' and created_at >= a and created_at < b) as orders,
       (select coalesce(sum(total_cents - coalesce(cost_cents, total_cents)), 0) from app.orders, bounds where status = 'delivered' and created_at >= a and created_at < b) as margin,
       (select coalesce(sum(amount_cents), 0) from app.ledger, bounds where kind = 'referral' and created_at >= a and created_at < b) as rewards,
       (select coalesce(sum(amount_cents), 0) from app.ledger, bounds where kind = 'topup' and created_at >= a and created_at < b) as topups_cents,
       (select count(*) from app.ledger, bounds where kind = 'topup' and created_at >= a and created_at < b) as topups,
       (select count(*) from app.users, bounds where created_at >= a and created_at < b) as new_users,
       (select coalesce(sum(total_cents), 0) from app.orders, bounds where status = 'delivered' and paid_with = 'in_person' and created_at >= a and created_at < b) as in_person,
       (select count(*) from app.orders, bounds where status = 'delivered' and paid_with = 'in_person' and created_at >= a and created_at < b) as in_person_orders,
       (select count(*) from app.orders, bounds where status = 'failed' and created_at >= a and created_at < b) as failed,
       (select count(*) from app.orders, bounds where status = 'refunded' and created_at >= a and created_at < b) as refunded,
       (select count(*) from app.orders where status in ('paid', 'processing')) as open_orders,
       (select count(*) from app.payments where status = 'review') as to_review,
       (select coalesce(array_agg(name order by name), '{}') from app.suppliers
         where enabled and balance_cents is not null and low_balance_cents > 0 and balance_cents < low_balance_cents) as low`,
    [date, timeZone],
  );
  const g = r ?? {};
  const rewards = n(g.rewards);
  return {
    date,
    salesCents: n(g.sales), orders: n(g.orders), profitCents: n(g.margin) - rewards, rewardsCents: rewards,
    topupsCents: n(g.topups_cents), topups: n(g.topups), newUsers: n(g.new_users),
    inPersonCents: n(g.in_person), inPersonOrders: n(g.in_person_orders),
    failedOrders: n(g.failed), refundedOrders: n(g.refunded), openOrders: n(g.open_orders), toReview: n(g.to_review),
    lowSuppliers: Array.isArray(g.low) ? (g.low as string[]) : [],
  };
}

/** The summary message, in the owner's language. */
export function summaryText(s: DaySummary, locale: "ar" | "en"): string {
  const ar = locale === "ar";
  const lines = ar
    ? [
        `ملخص اليوم · ${s.date}`,
        `المبيعات: ${formatUsd(s.salesCents)} (${s.orders} طلب)`,
        `الربح: ${formatUsd(s.profitCents)}${s.rewardsCents ? ` (بعد ${formatUsd(s.rewardsCents)} مكافآت دعوة)` : ""}`,
        `الشحنات: ${formatUsd(s.topupsCents)} (${s.topups})`,
        ...(s.inPersonOrders ? [`مبيعات مباشرة (نقداً معك): ${formatUsd(s.inPersonCents)} (${s.inPersonOrders})`] : []),
        `عملاء جدد: ${s.newUsers}`,
      ]
    : [
        `Daily summary · ${s.date}`,
        `Sales: ${formatUsd(s.salesCents)} (${s.orders} orders)`,
        `Profit: ${formatUsd(s.profitCents)}${s.rewardsCents ? ` (after ${formatUsd(s.rewardsCents)} invite rewards)` : ""}`,
        `Top-ups: ${formatUsd(s.topupsCents)} (${s.topups})`,
        ...(s.inPersonOrders ? [`In person (cash with you): ${formatUsd(s.inPersonCents)} (${s.inPersonOrders})`] : []),
        `New customers: ${s.newUsers}`,
      ];
  const attention: string[] = [];
  if (s.failedOrders) attention.push(ar ? `${s.failedOrders} طلب فاشل` : `${s.failedOrders} failed orders`);
  if (s.openOrders) attention.push(ar ? `${s.openOrders} طلب مفتوح` : `${s.openOrders} open orders`);
  if (s.toReview) attention.push(ar ? `${s.toReview} شحنة للمراجعة` : `${s.toReview} top-ups to review`);
  if (s.lowSuppliers.length) attention.push(ar ? `رصيد منخفض: ${s.lowSuppliers.join("، ")}` : `Low balance: ${s.lowSuppliers.join(", ")}`);
  if (attention.length) lines.push("", ar ? `يحتاج انتباهك: ${attention.join(" · ")}` : `Needs attention: ${attention.join(" · ")}`);
  return lines.join("\n");
}

/** The local date before `date` (YYYY-MM-DD). */
export function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * At the chosen local hour, queue YESTERDAY's summary (a complete day) for every
 * owner, once per day: the sending date is claimed in app.settings in the same
 * transaction as the messages, so overlapping or repeated runs send one.
 */
export async function queueDailySummary(svc: Services): Promise<boolean> {
  const rows = await svc.db.query<{ key: string; value: unknown }>(
    `select key, value from app.settings where key in ('reports.daily', 'reports.daily_hour')`,
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (s["reports.daily"] === false) return false;
  const hour = typeof s["reports.daily_hour"] === "number" ? s["reports.daily_hour"] : 9;
  const now = localNow(svc.now());
  if (now.hour !== hour) return false;
  return svc.db.tx(async (db) => {
    const claimed = await db.query(
      `insert into app.settings (key, value) values ('reports.daily_last', to_jsonb($1::text))
       on conflict (key) do update set value = excluded.value, updated_at = now()
         where app.settings.value is distinct from excluded.value
       returning key`,
      [now.date],
    );
    if (!claimed.length) return false;
    const summary = await daySummary({ db }, previousDay(now.date));
    await db.query(
      `insert into app.outbox (user_id, template, data)
       select id, 'daily_summary', $1::text::jsonb from app.users where role = 'owner' and status = 'active'`,
      [JSON.stringify(summary)],
    );
    return true;
  });
}

// ───────────────────────────────────────────────────────────── CSV exports

const MAX_ROWS = 5000;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Spreadsheet formula injection: a cell starting with = + - @ is shown as text.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  // Quoted when it holds a separator of any kind (Excel may use ";" instead of ",").
  return /[",;\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // The BOM makes Excel read Arabic text as UTF-8.
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const dollars = (c: unknown) => (c === null || c === undefined ? "" : (n(c) / 100).toFixed(2));

const EXPORTS: Record<string, { header: string[]; sql: string; row: (r: Record<string, unknown>) => unknown[] }> = {
  orders: {
    header: ["number", "created_at", "status", "channel", "customer", "telegram", "email", "product", "package", "quantity",
      "unit_price_usd", "discount_usd", "paid_usd", "cost_usd", "margin_usd", "coupon", "supplier", "supplier_order_id", "delivered_at"],
    sql: `select o.number, o.created_at, o.status, o.channel, u.display_name, t.username, e.email, p.name_en as product, f.name_en as package,
                 o.quantity, o.unit_price_cents, o.discount_cents, o.total_cents, o.cost_cents, c.code as coupon,
                 o.supplier_id, o.supplier_order_id, o.delivered_at
            from app.orders o
            join app.users u on u.id = o.user_id
            join app.products p on p.id = o.product_id
            join app.offers f on f.id = o.offer_id
            left join app.coupons c on c.id = o.coupon_id
            left join app.identities t on t.user_id = u.id and t.provider = 'telegram'
            left join app.identities e on e.user_id = u.id and e.provider = 'supabase'
           where o.created_at >= $1 and o.created_at < $2
           order by o.number limit ${MAX_ROWS + 1}`,
    row: (r) => [r.number, r.created_at, r.status, r.channel, r.display_name, r.username ?? "", r.email, r.product, r.package,
      r.quantity, dollars(r.unit_price_cents), dollars(r.discount_cents), dollars(r.total_cents), dollars(r.cost_cents),
      r.status === "delivered" && r.cost_cents !== null ? dollars(n(r.total_cents) - n(r.cost_cents)) : "",
      r.coupon, r.supplier_id, r.supplier_order_id, r.delivered_at],
  },
  topups: {
    header: ["created_at", "status", "method", "customer", "telegram", "asked_usd", "credited_usd", "provider_ref", "tx_hash", "paid_at", "note"],
    sql: `select p.created_at, p.status, p.method, u.display_name, t.username, p.amount_cents, p.credited_cents, p.provider_ref, p.tx_hash, p.paid_at, p.note
            from app.payments p join app.users u on u.id = p.user_id
            left join app.identities t on t.user_id = u.id and t.provider = 'telegram'
           where p.created_at >= $1 and p.created_at < $2
           order by p.created_at limit ${MAX_ROWS + 1}`,
    row: (r) => [r.created_at, r.status, r.method, r.display_name, r.username ?? "", dollars(r.amount_cents),
      dollars(r.credited_cents), r.provider_ref, r.tx_hash, r.paid_at, r.note],
  },
  wallet: {
    header: ["id", "created_at", "customer", "telegram", "kind", "amount_usd", "balance_after_usd", "ref_type", "ref_id", "note"],
    sql: `select l.id, l.created_at, u.display_name, t.username, l.kind, l.amount_cents, l.balance_after_cents, l.ref_type, l.ref_id, l.note
            from app.ledger l join app.users u on u.id = l.user_id
            left join app.identities t on t.user_id = u.id and t.provider = 'telegram'
           where l.created_at >= $1 and l.created_at < $2
           order by l.id limit ${MAX_ROWS + 1}`,
    row: (r) => [r.id, r.created_at, r.display_name, r.username ?? "", r.kind, dollars(r.amount_cents),
      dollars(r.balance_after_cents), r.ref_type, r.ref_id, r.note],
  },
};

/** GET /api/admin/export/:kind?from=YYYY-MM-DD&to=YYYY-MM-DD (local days, inclusive; at most 366 days). */
export async function exportCsv(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const kind = (ctx.params.kind ?? "").replace(/\.csv$/, "");
  const spec = EXPORTS[kind];
  if (!spec) throw new ApiError("not_found");
  const today = localNow(ctx.svc.now()).date;
  const day = (v: string | null, fallback: string) => {
    if (v === null || v === "") return fallback;
    // A real calendar day: 2026-02-31 parses in JavaScript but is not one.
    const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN;
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v || v < "2000-01-01") throw new ApiError("invalid_input", "from");
    return v;
  };
  const to = day(ctx.url.searchParams.get("to"), today);
  const from = day(ctx.url.searchParams.get("from"), new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10));
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (span < 0 || span > 366) throw new ApiError("invalid_input", "from");
  const range = await one<{ a: string; b: string }>(
    ctx.svc.db,
    `select (($1::date)::timestamp at time zone $3) as a, (($2::date + 1)::timestamp at time zone $3) as b`,
    [from, to, TIME_ZONE],
  );
  const rows = await ctx.svc.db.query<Record<string, unknown>>(spec.sql, [range!.a, range!.b]);
  const truncated = rows.length > MAX_ROWS;
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, 'export', 'report', $2, $3::text::jsonb)`,
    [staff.id, kind, JSON.stringify({ from, to, rows: Math.min(rows.length, MAX_ROWS) })],
  );
  return new Response(toCsv(spec.header, rows.slice(0, MAX_ROWS).map(spec.row)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${store.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${kind}-${from}-to-${to}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(truncated ? { "x-truncated": `first ${MAX_ROWS} rows; choose a shorter range` } : {}),
    },
  });
}
