/**
 * Admin → Orders → Waiting: orders a person has to finish.
 *
 * GET  /api/admin/orders/:id          one order: product, customer, what they
 *                                     typed before paying, the details given
 *                                     after paying (decrypted; every look is
 *                                     audit logged) and what was delivered so far
 *                                     (kind and label only: the values are hidden)
 * POST /api/admin/orders/:id/reveal   { deliveryId? } a delivered value (or all of
 *                                     them), decrypted; every look is audit logged
 * POST /api/admin/orders/:id/deliver  { items: [{ kind, label?, value }] }
 *                                     deliver an order sold by hand, or release
 *                                     one the supplier delivered (items optional:
 *                                     added to what the supplier sent)
 *
 * POST /api/admin/orders/in-person { offerId, quantity?, input?, idempotencyKey }
 *                                     the owner sells a package face to face: placed
 *                                     like a customer's order, no wallet charged
 *
 * Owners and support staff only (monitors see the list, never the details).
 * Refunds stay on POST /api/admin/orders/:id/refund.
 */
import { AFTER_SECRET, decryptText, encryptText, type AfterField, type InputField } from "@store/core";
import { requireStaff } from "./auth";
import type { Ctx } from "./context";
import { call, n, one } from "./db";
import { fulfilOrder, validateInput } from "./fulfilment";
import { ApiError, int, json, readJson, str, uuid } from "./http";

const KINDS = new Set(["account", "code", "link", "id"]);
const MAX_ITEMS = 20;
const MAX_VALUE = 4000;

async function audit(ctx: Ctx, actor: string, action: string, id: string, data: Record<string, unknown> = {}) {
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, $2, 'order', $3, $4::text::jsonb)`,
    [actor, action, id, JSON.stringify(data)],
  );
}

export async function getAdminOrder(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "support");
  const id = uuid(ctx.params.id);
  const o = await one<{
    id: string; number: string | number; status: string; hold: string | null; total_cents: string | number; cost_cents: string | number | null;
    created_at: string; delivered_at: string | null; answered_at: string | null; answers_enc: string | null; input: Record<string, string>;
    supplier_id: string | null; supplier_order_id: string | null; last_error: string | null; channel: string;
    product_en: string; product_ar: string; offer_en: string; offer_ar: string; kind: string; delivery: string;
    after_fields: AfterField[]; input_fields: InputField[]; display_name: string | null; user_id: string; telegram: string | null; email: string | null;
  }>(
    ctx.svc.db,
    `select o.id, o.number, o.status, o.hold, o.total_cents, o.cost_cents, o.created_at, o.delivered_at, o.answered_at, o.answers_enc, o.input,
            o.supplier_id, o.supplier_order_id, o.last_error, o.channel,
            p.name_en as product_en, p.name_ar as product_ar, f.name_en as offer_en, f.name_ar as offer_ar, p.kind, p.delivery,
            p.after_fields, f.input_fields, u.display_name, u.id as user_id,
            (select username from app.identities i where i.user_id = u.id and i.provider = 'telegram' limit 1) as telegram,
            (select email from app.identities i where i.user_id = u.id and i.provider = 'supabase' limit 1) as email
       from app.orders o join app.products p on p.id = o.product_id join app.offers f on f.id = o.offer_id join app.users u on u.id = o.user_id
      where o.id = $1`,
    [id],
  );
  if (!o) throw new ApiError("not_found");
  const given = o.answers_enc ? (JSON.parse(await decryptText(o.answers_enc, ctx.env.DATA_KEY)) as Record<string, string>) : {};
  if (o.answers_enc) await audit(ctx, staff.id, "order.details_view", id);
  // What was delivered stays hidden here (codes are money): "Show" asks for each
  // one on its own (revealDeliveries), and every look is audit logged.
  const dels = await ctx.svc.db.query<{ id: string | number; kind: string; label: string | null; created_at: string }>(
    `select id, kind, label, created_at from app.deliveries where order_id = $1 order by id`,
    [id],
  );
  const deliveries = dels.map((d) => ({ id: String(d.id), kind: d.kind, label: d.label, value: null, masked: true, at: d.created_at }));
  const events = await ctx.svc.db.query<{ type: string; at: string }>(
    `select type, at from app.order_events where order_id = $1 order by id limit 50`,
    [id],
  );
  return json({
    order: {
      id: o.id, number: n(o.number), status: o.status, hold: o.hold, totalCents: n(o.total_cents),
      costCents: o.cost_cents === null ? null : n(o.cost_cents), createdAt: o.created_at, deliveredAt: o.delivered_at, answeredAt: o.answered_at,
      supplierId: o.supplier_id, supplierOrderId: o.supplier_order_id, lastError: o.last_error, channel: o.channel,
      productEn: o.product_en, productAr: o.product_ar, packageEn: o.offer_en, packageAr: o.offer_ar, kind: o.kind, delivery: o.delivery,
      customer: { id: o.user_id, name: o.display_name, telegram: o.telegram, email: o.email },
      // Typed before paying (player ID, activation email...).
      input: (o.input_fields ?? []).filter((f) => o.input?.[f.key]).map((f) => ({ label: f.labelEn, labelAr: f.labelAr ?? f.labelEn, value: o.input[f.key]! })),
      // Given after paying (secrets included: this is who delivers).
      details: (o.after_fields ?? []).map((f) => ({
        key: f.key, type: f.type, label: f.labelEn, labelAr: f.labelAr, secret: AFTER_SECRET.has(f.type), value: given[f.key] ?? null,
      })),
    },
    deliveries,
    events: events.map((e) => ({ type: e.type, at: e.at })),
  });
}

/**
 * POST /api/admin/orders/:id/reveal { deliveryId? } — what was delivered, decrypted:
 * one delivery, or all of the order's. Every call is audit logged (who, which).
 */
export async function revealDeliveries(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "support");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const deliveryId = body.deliveryId === undefined || body.deliveryId === null ? null : String(body.deliveryId);
  if (deliveryId !== null && !/^\d{1,18}$/.test(deliveryId)) throw new ApiError("invalid_input", "deliveryId");
  const dels = await ctx.svc.db.query<{ id: string | number; kind: string; value_enc: string; label: string | null; created_at: string }>(
    `select id, kind, value_enc, label, created_at from app.deliveries
      where order_id = $1 and ($2::bigint is null or id = $2::bigint) order by id`,
    [id, deliveryId],
  );
  if (!dels.length) throw new ApiError("not_found");
  // Logged before anything is decrypted, so a look is never missing from the log.
  await audit(ctx, staff.id, "order.deliveries_view", id, { deliveries: dels.map((d) => String(d.id)) });
  const deliveries = [];
  for (const d of dels) {
    deliveries.push({ id: String(d.id), kind: d.kind, label: d.label, value: await decryptText(d.value_enc, ctx.env.DATA_KEY), at: d.created_at });
  }
  return json({ deliveries });
}

export async function deliverOrder(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "support");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req, 131_072);
  const raw = Array.isArray(body.items) ? body.items : [];
  if (raw.length > MAX_ITEMS) throw new ApiError("invalid_input", "items");
  const items: { kind: string; label: string | null; value: string }[] = [];
  for (const it of raw) {
    const r = (it ?? {}) as Record<string, unknown>;
    const value = typeof r.value === "string" ? r.value.trim() : "";
    if (!value) continue;
    const kind = typeof r.kind === "string" && KINDS.has(r.kind) ? r.kind : "code";
    const label = typeof r.label === "string" && r.label.trim() ? r.label.replace(/\s+/g, " ").trim().slice(0, 60) : null;
    if (value.length > MAX_VALUE) throw new ApiError("invalid_input", "items");
    items.push({ kind, label, value });
  }
  let number = 0;
  await ctx.svc.db.tx(async (db) => {
    const o = await one<{ status: string; hold: string | null; user_id: string; number: string | number }>(
      db,
      `select status, hold, user_id, number from app.orders where id = $1 for update`,
      [id],
    );
    if (!o) throw new ApiError("not_found");
    // Sold by hand ('owner'), or bought and waiting for a check ('release'). An order still
    // waiting for the customer's details can be delivered too, if the team has what it needs.
    if (!["paid", "processing"].includes(o.status) || !o.hold) throw new ApiError("bad_state");
    if (o.hold !== "release" && !items.length) throw new ApiError("invalid_input", "items");
    for (const it of items) {
      await db.query(`insert into app.deliveries (order_id, kind, value_enc, label) values ($1, $2, $3, $4)`, [
        id, it.kind, await encryptText(it.value, ctx.env.DATA_KEY), it.label,
      ]);
    }
    await db.query(`update app.orders set status = 'delivered', delivered_at = now(), hold = null, next_check_at = null, last_error = null where id = $1`, [id]);
    await db.query(`insert into app.order_events (order_id, type, data) values ($1, $2, $3::text::jsonb)`, [
      id, o.hold === "release" ? "released" : "delivered_by_hand", JSON.stringify({ actor: staff.id, items: items.length }),
    ]);
    await db.query(`insert into app.outbox (user_id, template, data) values ($1, 'order_delivered', $2::text::jsonb)`, [
      o.user_id, JSON.stringify({ order_id: id, number: n(o.number) }),
    ]);
    number = n(o.number);
  });
  await audit(ctx, staff.id, "order.deliver", id, { items: items.length });
  return json({ ok: true, number });
}

/**
 * The owner sells a package face to face and takes the money themselves: the
 * order is placed like a customer's (the supplier delivers, or it waits for
 * the owner), shows in the owner's own Orders, and charges no wallet.
 */
export async function placeInPersonOrder(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req);
  const offerId = uuid(str(body, "offerId", { max: 36 }), "offerId");
  const quantity = body.quantity === undefined ? 1 : int(body, "quantity", 1, 100);
  const idem = str(body, "idempotencyKey", { min: 8, max: 100, pattern: /^[A-Za-z0-9_-]+$/ });
  const offer = await one<{ input_fields: InputField[] }>(ctx.svc.db, `select input_fields from app.offers where id = $1`, [offerId]);
  if (!offer) throw new ApiError("offer_unavailable");
  const raw = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
  const checked = validateInput(offer.input_fields, raw);
  if (!checked.ok) throw new ApiError("invalid_input", `input.${checked.field}`);
  const rows = await call<{ order_id: string; order_number: string | number; status: string; total_cents: string | number; created: boolean }>(
    ctx.svc.db,
    `select * from app.place_in_person_order($1, $2, $3, $4::text::jsonb, $5)`,
    [staff.id, offerId, quantity, JSON.stringify(checked.values), idem],
  );
  const r = rows[0];
  if (!r) throw new ApiError("internal");
  if (r.created) {
    await audit(ctx, staff.id, "order.in_person", r.order_id, { offerId, quantity, totalCents: n(r.total_cents) });
    if (r.status === "paid") ctx.svc.waitUntil(fulfilOrder(ctx.svc, ctx.env, r.order_id).catch((e) => console.error("fulfil failed", r.order_id, String(e))));
  }
  return json({ orderId: r.order_id, number: n(r.order_number), status: r.status, totalCents: n(r.total_cents), created: r.created }, { status: r.created ? 201 : 200 });
}
