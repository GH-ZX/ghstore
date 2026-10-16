/**
 * Placing orders and showing them (with decrypted deliveries) to their owner.
 *
 * Some orders wait for someone (orders.hold, migration 0021): 'info' for the
 * customer's details asked after paying (POST /api/orders/:id/answers), 'owner'
 * for a person to deliver a product sold by hand, 'release' for a person to
 * check what the supplier delivered (hidden from the customer until then).
 */
import { AFTER_SECRET, checkAnswers, decryptText, encryptText, type AfterField, type InputField } from "@store/core";
import { requireUser } from "./auth";
import type { Ctx } from "./context";
import { call, n, one } from "./db";
import { fulfilOrder, validateInput } from "./fulfilment";
import { ApiError, int, json, readJson, str, uuid } from "./http";
import { alertNewOrder, alertStaff } from "./notify";
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
    // A product that needs the customer's details after paying: remind them where to give them.
    await ctx.svc.db.query(
      `insert into app.outbox (user_id, template, data)
       select user_id, 'order_needs_info', jsonb_build_object('order_id', id, 'number', number) from app.orders where id = $1 and hold = 'info'`,
      [r.order_id],
    );
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
    name_ar: string; name_en: string; offer_ar: string; offer_en: string; kind: string; hold: string | null;
  }>(
    `select o.id, o.number, o.status, o.total_cents, o.created_at, p.name_ar, p.name_en, f.name_ar as offer_ar, f.name_en as offer_en, p.kind, o.hold
       from app.orders o join app.products p on p.id = o.product_id join app.offers f on f.id = o.offer_id
      where o.user_id = $1 and ($2::bigint is null or o.number < $2::bigint)
      order by o.number desc limit 30`,
    [user.id, before && /^\d+$/.test(before) ? before : null],
  );
  return json({
    orders: rows.map((r) => ({
      id: r.id, number: n(r.number), status: r.status, totalCents: n(r.total_cents), createdAt: r.created_at, kind: r.kind, hold: r.hold,
      productAr: r.name_ar, productEn: r.name_en, packageAr: r.offer_ar, packageEn: r.offer_en,
    })),
  });
}

interface OrderView {
  id: string; number: string | number; status: string; total_cents: string | number; discount_cents: string | number; created_at: string;
  delivered_at: string | null; input: Record<string, string>; slug: string; product_active: boolean; name_ar: string; name_en: string;
  offer_ar: string; offer_en: string; input_fields: InputField[]; kind: string; supplier_id: string | null; supplier_order_id: string | null;
  supplier_expires_at: string | Date | null; stale: boolean;
  hold: string | null; answers_enc: string | null; answered_at: string | null; after_fields: AfterField[];
  offer_id: string; quantity: number;
}

/** Ownership is part of the query: another user's order is simply "not found". */
async function ownOrder(ctx: Ctx, id: string, userId: string): Promise<OrderView | undefined> {
  return one<OrderView>(
    ctx.svc.db,
    `select o.id, o.number, o.status, o.total_cents, o.discount_cents, o.created_at, o.delivered_at, o.input,
            p.slug, p.active as product_active, p.name_ar, p.name_en, p.kind,
            f.name_ar as offer_ar, f.name_en as offer_en, f.input_fields,
            o.supplier_id, o.supplier_order_id, o.supplier_expires_at,
            o.updated_at < now() - interval '4 seconds' as stale,
            o.hold, o.answers_enc, o.answered_at, p.after_fields, o.offer_id, o.quantity
       from app.orders o join app.products p on p.id = o.product_id join app.offers f on f.id = o.offer_id
      where o.id = $1 and o.user_id = $2`,
    [id, userId],
  );
}

const open = (status: string) => status === "paid" || status === "processing";

export async function getOrder(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  let o = await ownOrder(ctx, id, user.id);
  if (!o) throw new ApiError("not_found");
  // A virtual number is waiting for its code while the customer watches: ask the supplier now
  // (at most every few seconds) instead of waiting for the scheduled check.
  if (o.kind === "sms" && open(o.status) && o.supplier_order_id && o.stale) {
    await fulfilOrder(ctx.svc, ctx.env, o.id).catch((e) => console.error("number check failed", o?.id, String(e)));
    o = (await ownOrder(ctx, id, user.id)) ?? o;
  }
  // What the supplier delivered waits for a person's check before the customer sees it.
  const dels = o.hold === "release"
    ? []
    : await ctx.svc.db.query<{ id: string | number; kind: string; value_enc: string; label: string | null }>(
        `select id, kind, value_enc, label from app.deliveries where order_id = $1 order by id`,
        [id],
      );
  if (dels.length) await ctx.svc.db.query(`update app.deliveries set first_viewed_at = now() where order_id = $1 and first_viewed_at is null`, [id]);
  // The details given after paying: shown back without the secrets (passwords, tokens).
  const given = o.answers_enc ? (JSON.parse(await decryptText(o.answers_enc, ctx.env.DATA_KEY)) as Record<string, string>) : {};
  const fields = o.after_fields ?? [];
  const deliveries = [];
  for (const d of dels) deliveries.push({ kind: d.kind, label: d.label, value: await decryptText(d.value_enc, ctx.env.DATA_KEY) });
  const expires = o.supplier_expires_at ? new Date(o.supplier_expires_at).toISOString() : null;
  // Before its code arrives, a number can be cancelled or reported as already used (both refunded).
  const numberActions = o.kind === "sms" && o.status === "processing" && !!o.supplier_order_id && !dels.some((d) => d.kind === "sms") && !!ctx.svc.supplier(o.supplier_id ?? "")?.cancel;
  return json({
    order: {
      id: o.id, number: n(o.number), status: o.status, totalCents: n(o.total_cents), discountCents: n(o.discount_cents), createdAt: o.created_at,
      deliveredAt: o.delivered_at, input: o.input, productAr: o.name_ar, productEn: o.name_en,
      packageAr: o.offer_ar, packageEn: o.offer_en,
      // For "Buy again" (only while the product is on sale).
      productSlug: o.product_active ? o.slug : null,
      // Labels for the details the customer typed (player ID, server...).
      fields: (o.input_fields ?? []).map((f) => ({ key: f.key, labelEn: f.labelEn, labelAr: f.labelAr ?? null })),
      kind: o.kind,
      // Virtual numbers: when the number ends, and whether it can still be cancelled.
      expiresAt: expires,
      numberActions,
      // Waiting for: the customer's details ('info'), the team ('owner', 'release'), or nothing.
      hold: o.hold,
      afterFields: fields.map((f) => ({
        key: f.key, type: f.type, labelEn: f.labelEn, labelAr: f.labelAr, hintEn: f.hintEn ?? null, hintAr: f.hintAr ?? null, required: f.required,
        value: AFTER_SECRET.has(f.type) ? null : given[f.key] ?? null,
        given: f.key in given,
      })),
      answeredAt: o.answered_at,
      // Details can be corrected until the order is delivered.
      canAnswer: open(o.status) && (o.hold === "info" || o.hold === "owner") && fields.length > 0,
    },
    deliveries,
  });
}

/**
 * POST /api/orders/:id/number { action: "cancel" | "used", again?: true } — a
 * virtual number that has not received its code yet: cancel it, or report it
 * as already used by the service. The supplier releases it (and charges
 * nothing), and the order is refunded to the wallet. If the code arrived
 * meanwhile, it is fetched instead and nothing is refunded.
 *
 * `again`: then buy another number of the same package right away (what 5sim
 * users do: ban, buy again, until a code comes). Answers the new order's id.
 */
export async function closeNumber(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const action = body.action === "used" ? "used" : body.action === "cancel" ? "cancel" : null;
  if (!action) throw new ApiError("invalid_input", "action");
  const o = await ownOrder(ctx, id, user.id);
  if (!o) throw new ApiError("not_found");
  if (o.kind !== "sms" || o.status !== "processing" || !o.supplier_order_id || !o.supplier_id) throw new ApiError("bad_state");
  const adapter = ctx.svc.supplier(o.supplier_id);
  if (!adapter?.cancel) throw new ApiError("bad_state");
  const has = await one(ctx.svc.db, `select 1 from app.deliveries where order_id = $1 and kind = 'sms'`, [id]);
  if (has) throw new ApiError("bad_state", "code");

  let closed: boolean;
  try {
    closed = action === "used" && adapter.ban ? await adapter.ban(o.supplier_order_id) : await adapter.cancel(o.supplier_order_id);
  } catch {
    throw new ApiError("rate_limited"); // the supplier did not answer: try again in a moment
  }
  if (!closed) {
    // Refused: the code may have just arrived. Fetch it.
    await fulfilOrder(ctx.svc, ctx.env, id).catch(() => null);
    return json({ closed: false });
  }
  const reason = action === "used" ? "customer: number already used" : "customer: cancelled the number";
  await ctx.svc.db.tx(async (db) => {
    const locked = await one<{ status: string }>(db, `select status from app.orders where id = $1 for update`, [id]);
    if (!locked || locked.status !== "processing") return;
    await db.query(`update app.orders set status = 'failed', last_error = $2, next_check_at = null where id = $1`, [id, reason]);
    await db.query(`insert into app.order_events (order_id, type, data) values ($1, 'number_closed', $2::text::jsonb)`, [id, JSON.stringify({ action })]);
    await call(db, `select * from app.refund_order($1, $2)`, [id, reason]);
  });
  if (body.again !== true) return json({ closed: true });
  // Another number of the same package, paid from the refund just made.
  try {
    const channel = user.channel === "miniapp" ? "miniapp" : "web";
    const rows = await call<{ order_id: string; status: string; created: boolean }>(
      ctx.svc.db,
      `select * from app.place_order($1, $2, 1, $3::text::jsonb, $4, $5, null)`,
      [user.id, o.offer_id, JSON.stringify(o.input ?? {}), `again-${id}`.slice(0, 100), channel],
    );
    const next = rows[0];
    if (!next) throw new ApiError("internal");
    if (next.created && next.status === "paid") {
      ctx.svc.waitUntil(fulfilOrder(ctx.svc, ctx.env, next.order_id).catch((e) => console.error("fulfil failed", next.order_id, String(e))));
    }
    return json({ closed: true, orderId: next.order_id });
  } catch (err) {
    // Refunded either way; the new number could not be bought (sold out, wallet...).
    return json({ closed: true, againError: err instanceof ApiError ? err.code : "internal" });
  }
}

/**
 * POST /api/orders/:id/answers { values: { email, password, token, ... } } —
 * the details a product needs after paying. Stored encrypted; correctable
 * until the order is delivered (an empty secret keeps the one already given).
 * Then the supplier is asked (products a supplier activates), or the team is
 * told (products delivered by hand).
 */
export async function submitAnswers(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req, 65_536);
  const input = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : {};
  const o = await ownOrder(ctx, id, user.id);
  if (!o) throw new ApiError("not_found");
  const fields = o.after_fields ?? [];
  if (!open(o.status) || !(o.hold === "info" || o.hold === "owner") || !fields.length) throw new ApiError("bad_state");
  const previous = o.answers_enc ? (JSON.parse(await decryptText(o.answers_enc, ctx.env.DATA_KEY)) as Record<string, string>) : {};
  const checked = checkAnswers(fields, input, previous);
  if (!checked.ok) throw new ApiError("invalid_input", `answers.${checked.field}`);
  const enc = await encryptText(JSON.stringify(checked.values), ctx.env.DATA_KEY);
  const first = o.hold === "info";
  const toSupplier = !!o.supplier_id;
  await ctx.svc.db.tx(async (db) => {
    const locked = await one<{ status: string; hold: string | null }>(db, `select status, hold from app.orders where id = $1 for update`, [id]);
    if (!locked || !open(locked.status) || !(locked.hold === "info" || locked.hold === "owner")) throw new ApiError("bad_state");
    await db.query(
      `update app.orders set answers_enc = $2, answered_at = now(),
              hold = case when $3::boolean then null else 'owner' end,
              next_check_at = case when $3::boolean then now() else next_check_at end
        where id = $1`,
      [id, enc, toSupplier],
    );
    await db.query(`insert into app.order_events (order_id, type) values ($1, $2)`, [id, first ? "details_given" : "details_corrected"]);
  });
  if (!toSupplier) {
    // The values themselves never go into a message: the team reads them in the admin.
    const ref = `${store.orderPrefix}${n(o.number)}`;
    await alertStaff(
      ctx.svc,
      first ? `Order ${ref} (${o.name_en}) has the customer's details: deliver it in Admin → Orders → Waiting.` : `Order ${ref}: the customer corrected their details.`,
      ["owner", "support"],
    );
  } else {
    ctx.svc.waitUntil(fulfilOrder(ctx.svc, ctx.env, id).catch((e) => console.error("fulfil failed", id, String(e))));
  }
  return json({ ok: true });
}
