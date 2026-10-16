/**
 * Admin → Profit: sales, costs and profit over any range of local days, by day,
 * supplier, product and category, with the payment methods top-ups came in by.
 * Owner only.
 *
 * GET /api/admin/reports/profit?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, at most 366 days)
 *
 * Sales are delivered orders at what the customer paid (after coupons); cost is
 * what the supplier charged (unknown cost counts as no profit); profit is the
 * difference, less the invite rewards paid in the range. Sales made in person
 * (paid by hand to the owner) are counted like the others, and also shown apart.
 */
import { requireStaff } from "./auth";
import type { Ctx } from "./context";
import { n, one } from "./db";
import { ApiError, json } from "./http";
import { localNow, TIME_ZONE } from "./reports";

function day(v: string | null, fallback: string): string {
  if (v === null || v === "") return fallback;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v || v < "2000-01-01") throw new ApiError("invalid_input", "from");
  return v;
}

export async function profitReport(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const db = ctx.svc.db;
  const today = localNow(ctx.svc.now()).date;
  const to = day(ctx.url.searchParams.get("to"), today);
  const from = day(ctx.url.searchParams.get("from"), new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10));
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (span < 0 || span > 366) throw new ApiError("invalid_input", "from");

  // The range in the store's time zone, and the delivered orders in it.
  const base = `with r as (select (($1::date)::timestamp at time zone $3) as a, (($2::date + 1)::timestamp at time zone $3) as b),
                d as (select o.* from app.orders o, r where o.status = 'delivered' and o.created_at >= r.a and o.created_at < r.b)`;
  const params = [from, to, TIME_ZONE];
  const profitOf = `sum(d.total_cents - coalesce(d.cost_cents, d.total_cents))`;

  const totals = await one<Record<string, string | number>>(
    db,
    `${base}
     select coalesce(sum(d.total_cents), 0) as sales, coalesce(sum(coalesce(d.cost_cents, d.total_cents)), 0) as cost,
            coalesce(${profitOf}, 0) as margin, count(*) as orders,
            coalesce(sum(d.discount_cents), 0) as discounts,
            coalesce(sum(d.total_cents) filter (where d.paid_with = 'in_person'), 0) as in_person,
            count(*) filter (where d.paid_with = 'in_person') as in_person_orders,
            count(*) filter (where d.cost_cents is null) as unknown_cost,
            (select coalesce(sum(l.amount_cents), 0) from app.ledger l, r where l.kind = 'referral' and l.created_at >= r.a and l.created_at < r.b) as rewards,
            (select count(*) from app.orders o, r where o.status = 'refunded' and o.created_at >= r.a and o.created_at < r.b) as refunded,
            (select count(distinct d2.user_id) from d d2) as customers
       from d`,
    params,
  );
  const days = await db.query<{ day: string; sales: string | number; profit: string | number; orders: string | number }>(
    `${base}
     select to_char(gs::date, 'YYYY-MM-DD') as day,
            coalesce(sum(d.total_cents), 0) as sales, coalesce(${profitOf}, 0) as profit, count(d.id) as orders
       from generate_series($1::date, $2::date, interval '1 day') gs
       left join d on (d.created_at at time zone $3)::date = gs::date
      group by gs order by gs`,
    params,
  );
  const bySupplier = await db.query<{ id: string | null; name: string | null; sales: string | number; cost: string | number; profit: string | number; orders: string | number }>(
    `${base}
     select coalesce(f.supplier_id, '') as id, s.name,
            sum(d.total_cents) as sales, sum(coalesce(d.cost_cents, d.total_cents)) as cost, ${profitOf} as profit, count(*) as orders
       from d join app.offers f on f.id = d.offer_id left join app.suppliers s on s.id = f.supplier_id
      group by 1, 2 order by profit desc`,
    params,
  );
  const byProduct = await db.query<{ id: string; name_en: string; name_ar: string; sales: string | number; profit: string | number; orders: string | number }>(
    `${base}
     select p.id, p.name_en, p.name_ar, sum(d.total_cents) as sales, ${profitOf} as profit, count(*) as orders
       from d join app.products p on p.id = d.product_id
      group by p.id order by profit desc, sales desc limit 20`,
    params,
  );
  const byCategory = await db.query<{ slug: string; name_en: string; name_ar: string; sales: string | number; profit: string | number; orders: string | number }>(
    `${base}
     select c.slug, c.name_en, c.name_ar, sum(d.total_cents) as sales, ${profitOf} as profit, count(*) as orders
       from d join app.products p on p.id = d.product_id join app.categories c on c.id = p.category_id
      group by c.id order by sales desc`,
    params,
  );
  const topups = await db.query<{ method: string; amount: string | number; count: string | number }>(
    `with r as (select (($1::date)::timestamp at time zone $3) as a, (($2::date + 1)::timestamp at time zone $3) as b)
     select p.method, sum(l.amount_cents) as amount, count(*) as count
       from app.ledger l join app.payments p on p.id = l.ref_id, r
      where l.kind = 'topup' and l.ref_type = 'payment' and l.created_at >= r.a and l.created_at < r.b
      group by p.method order by amount desc`,
    params,
  );

  const t = totals ?? {};
  const rewards = n(t.rewards);
  return json({
    from, to,
    totals: {
      salesCents: n(t.sales), costCents: n(t.cost), profitCents: n(t.margin) - rewards, rewardsCents: rewards, discountsCents: n(t.discounts),
      orders: n(t.orders), customers: n(t.customers), refunded: n(t.refunded), unknownCost: n(t.unknown_cost),
      inPersonCents: n(t.in_person), inPersonOrders: n(t.in_person_orders),
    },
    days: days.map((d) => ({ date: d.day, salesCents: n(d.sales), profitCents: n(d.profit), orders: n(d.orders) })),
    bySupplier: bySupplier.map((s) => ({
      id: s.id || null, name: s.name ?? (s.id ? s.id : null), salesCents: n(s.sales), costCents: n(s.cost), profitCents: n(s.profit), orders: n(s.orders),
    })),
    byProduct: byProduct.map((p) => ({ id: p.id, nameEn: p.name_en, nameAr: p.name_ar, salesCents: n(p.sales), profitCents: n(p.profit), orders: n(p.orders) })),
    byCategory: byCategory.map((c) => ({ slug: c.slug, nameEn: c.name_en, nameAr: c.name_ar, salesCents: n(c.sales), profitCents: n(c.profit), orders: n(c.orders) })),
    topups: topups.map((x) => ({ method: x.method, amountCents: n(x.amount), count: n(x.count) })),
  });
}
