/** Placing orders and showing them (with decrypted deliveries) to their owner. */
import { decryptText, type InputField } from "@store/core";
import { requireUser } from "./auth";
import type { Ctx } from "./context";
import { call, n, one } from "./db";
import { fulfilOrder, validateInput } from "./fulfilment";
import { ApiError, int, json, readJson, str, uuid } from "./http";
import { alertNewOrder } from "./notify";
import { couponCode } from "./promo";
import { store } from "@store/config";

const CHANNELS = new Set(["web", "miniapp", "bot"]);

export async function placeOrder(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const offerId = uuid(str(body, "offerId", { max: 36 }), "offerId");
  const quantity = body.quantity === undefined ? 1 : int(body, "quantity", 1, 100);
  const idem = str(body, "idempotencyKey", { min: 8, max: 100, pattern: /^[A-Za-z0-9_-]+$/ });
  const channel = user.channel === "miniapp" ? "miniapp" : "web";
  if (!CHANNELS.has(channel)) throw new ApiError("bad_request");
  const coupon = body.coupon === undefined || body.coupon === null || body.coupon === "" ? null : couponCode(body.coupon);

  const offer = await one<{ input_fields: InputField[]; supplier_on: boolean }>(
    ctx.svc.db,
    `select o.input_fields,
            (o.supplier_id is null or exists (select 1 from app.suppliers s where s.id = o.supplier_id and s.enabled)) as supplier_on
       from app.offers o where o.id = $1`,
    [offerId],
  );
  if (!offer) throw new ApiError("offer_unavailable");
  if (!offer.supplier_on) {
    // Its supplier is switched off in Admin → Suppliers. A repeat of an order that
    // was already placed still gets its answer from place_order below.
    const placed = await one(ctx.svc.db, `select 1 from app.orders where user_id = $1 and idempotency_key = $2`, [user.id, idem]);
    if (!placed) throw new ApiError("offer_unavailable");
  }
  const rawInput = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
  const checked = validateInput(offer.input_fields, rawInput);
  if (!checked.ok) throw new ApiError("invalid_input", `input.${checked.field}`);
  const input = checked.values;

  const rows = await call<{ order_id: string; order_number: string | number; status: string; total_cents: string | number; discount_cents: string | number; balance_cents: string | number; created: boolean }>(
    ctx.svc.db,
    `select * from app.place_order($1, $2, $3, $4::text::jsonb, $5, $6, $7)`,
    [user.id, offerId, quantity, JSON.stringify(input), idem, channel, coupon],
  );
  const r = rows[0];
  if (!r) throw new ApiError("internal");
  if (r.created) {
    // Owners and support staff hear about it (sent by the next outbox run).
    await alertNewOrder(ctx.svc, r.order_id, store.orderPrefix).catch((e) => console.error("new order alert failed", r.order_id, String(e)));
  }
  if (r.created && r.status === "paid") {
    ctx.svc.waitUntil(fulfilOrder(ctx.svc, ctx.env, r.order_id).catch((e) => console.error("fulfil failed", r.order_id, String(e))));
  }
  return json(
    {
      orderId: r.order_id, number: n(r.order_number), status: r.status, totalCents: n(r.total_cents),
      discountCents: n(r.discount_cents), balanceCents: n(r.balance_cents), created: r.created,
    },
    { status: r.created ? 201 : 200 },
  );
}

/** POST /api/webhooks/suppliers/:id — a wake-up call: we re-ask the supplier, never trust the body. */
export async function supplierWebhook(ctx: Ctx): Promise<Response> {
  const supplierId = ctx.params.id ?? "";
  const adapter = ctx.svc.supplier(supplierId);
  if (!adapter?.parseWebhook) throw new ApiError("not_found");
  const parsed = await adapter.parseWebhook(ctx.req);
  if (!parsed) throw new ApiError("unauthorized");
  const o = await one<{ id: string }>(
    ctx.svc.db,
    `update app.orders set next_check_at = now()
      where supplier_id = $1 and supplier_order_id = $2 and status in ('paid','processing') returning id`,
    [supplierId, parsed.supplierOrderId],
  );
  if (o) ctx.svc.waitUntil(fulfilOrder(ctx.svc, ctx.env, o.id).catch((e) => console.error("fulfil failed", o.id, String(e))));
  return json({ ok: true });
}

export async function listOrders(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const before = ctx.url.searchParams.get("before");
  const rows = await ctx.svc.db.query<{
    id: string; number: string | number; status: string; total_cents: string | number; created_at: string;
    name_ar: string; name_en: string; offer_ar: string; offer_en: string; kind: string;
  }>(
    `select o.id, o.number, o.status, o.total_cents, o.created_at, p.name_ar, p.name_en, f.name_ar as offer_ar, f.name_en as offer_en, p.kind
       from app.orders o join app.products p on p.id = o.product_id join app.offers f on f.id = o.offer_id
      where o.user_id = $1 and ($2::bigint is null or o.number < $2::bigint)
      order by o.number desc limit 30`,
    [user.id, before && /^\d+$/.test(before) ? before : null],
  );
  return json({
    orders: rows.map((r) => ({
      id: r.id, number: n(r.number), status: r.status, totalCents: n(r.total_cents), createdAt: r.created_at, kind: r.kind,
      productAr: r.name_ar, productEn: r.name_en, packageAr: r.offer_ar, packageEn: r.offer_en,
    })),
  });
}

export async function getOrder(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  // Ownership is part of the query: another user's order is simply "not found".
  const o = await one<{ id: string; number: string | number; status: string; total_cents: string | number; discount_cents: string | number; created_at: string; delivered_at: string | null; input: Record<string, string>; slug: string; product_active: boolean; name_ar: string; name_en: string; offer_ar: string; offer_en: string; input_fields: InputField[] }>(
    ctx.svc.db,
    `select o.id, o.number, o.status, o.total_cents, o.discount_cents, o.created_at, o.delivered_at, o.input,
            p.slug, p.active as product_active, p.name_ar, p.name_en,
            f.name_ar as offer_ar, f.name_en as offer_en, f.input_fields
       from app.orders o join app.products p on p.id = o.product_id join app.offers f on f.id = o.offer_id
      where o.id = $1 and o.user_id = $2`,
    [id, user.id],
  );
  if (!o) throw new ApiError("not_found");
  const dels = await ctx.svc.db.query<{ id: string | number; kind: string; value_enc: string; label: string | null }>(
    `select id, kind, value_enc, label from app.deliveries where order_id = $1 order by id`,
    [id],
  );
  await ctx.svc.db.query(`update app.deliveries set first_viewed_at = now() where order_id = $1 and first_viewed_at is null`, [id]);
  const deliveries = [];
  for (const d of dels) deliveries.push({ kind: d.kind, label: d.label, value: await decryptText(d.value_enc, ctx.env.DATA_KEY) });
  return json({
    order: {
      id: o.id, number: n(o.number), status: o.status, totalCents: n(o.total_cents), discountCents: n(o.discount_cents), createdAt: o.created_at,
      deliveredAt: o.delivered_at, input: o.input, productAr: o.name_ar, productEn: o.name_en,
      packageAr: o.offer_ar, packageEn: o.offer_en,
      // For "Buy again" (only while the product is on sale).
      productSlug: o.product_active ? o.slug : null,
      // Labels for the details the customer typed (player ID, server...).
      fields: (o.input_fields ?? []).map((f) => ({ key: f.key, labelEn: f.labelEn, labelAr: f.labelAr ?? null })),
    },
    deliveries,
  });
}
