/**
 * Getting a paid order from the supplier to the customer.
 *
 * Called right after an order is placed (in the background) and again by the
 * scheduled job for orders that are pending or failed with a retryable error.
 * Delivered values are encrypted before they are stored.
 *
 * A product set to "review" (products.delivery) is bought as usual, but what the
 * supplier delivers waits (orders.hold = 'release') until a person checks it
 * and releases it in Admin → Orders.
 *
 * A purchase the supplier refuses for lack of stock is refunded, and its
 * package stops selling at once (paused as "supplier_unavailable"); the price
 * check puts it back on sale when the supplier has stock again.
 */
import { encryptText, nextStep, type InputField, type PurchaseResult } from "@store/core";
import type { ApiEnv, Services } from "./context";
import { call, n, one } from "./db";
import { alertStaff } from "./notify";
import { store } from "@store/config";

interface OrderRow {
  id: string;
  number: string | number;
  user_id: string;
  offer_id: string;
  status: string;
  quantity: number;
  input: Record<string, string>;
  supplier_id: string | null;
  supplier_order_id: string | null;
  attempts: number;
  supplier_ref: string | null;
  offer_cost_cents: string | number | null;
  supplier_expires_at: string | Date | null;
  delivery: string;
  name_en: string;
  hold: string | null;
}

/** The supplier said it has none left (wording varies by supplier). */
export function isOutOfStock(result: PurchaseResult): boolean {
  return result.status === "failed" && (result.code === "out_of_stock" || /out of stock|no free (numbers|phones)|sold out/i.test(result.reason));
}

export async function fulfilOrder(svc: Services, env: ApiEnv, orderId: string): Promise<string> {
  const order = await one<OrderRow>(
    svc.db,
    `select o.id, o.number, o.user_id, o.offer_id, o.status, o.quantity, o.input, o.supplier_id, o.supplier_order_id, o.attempts, o.supplier_expires_at, o.hold,
            f.supplier_ref, f.cost_cents as offer_cost_cents, p.delivery, p.name_en
       from app.orders o join app.offers f on f.id = o.offer_id join app.products p on p.id = o.product_id
      where o.id = $1`,
    [orderId],
  );
  if (!order || !["paid", "processing"].includes(order.status) || !order.supplier_id) return order?.status ?? "missing";
  // Waiting for the customer's details, or for a person: nothing to ask the supplier yet.
  if (order.hold) return order.status;

  const adapter = svc.supplier(order.supplier_id);
  let result: PurchaseResult;
  try {
    if (!adapter) {
      result = { status: "failed", retryable: true, reason: "supplier_not_configured" };
    } else if (order.supplier_order_id) {
      result = await adapter.checkOrder(order.supplier_order_id);
    } else {
      result = await adapter.purchase({
        externalId: order.supplier_ref ?? "",
        quantity: order.quantity,
        fields: order.input,
        idempotencyKey: order.id,
        // Never pay more than the package was priced from, where the supplier can cap it.
        ...(order.offer_cost_cents !== null ? { maxCostCents: n(order.offer_cost_cents) } : {}),
      });
    }
  } catch (err) {
    // A thrown error says nothing about the order: try again later.
    result = { status: "failed", retryable: true, reason: err instanceof Error ? err.message.slice(0, 200) : "error" };
  }

  // Note: a retryable failure on an order the supplier already accepted keeps
  // its supplier_order_id, so the next run asks checkOrder instead of buying again.
  // Purchases pass our order id as the idempotency key where the supplier supports one.
  const step = nextStep(result, order.attempts);
  const supplierOrderId = "supplierOrderId" in result ? result.supplierOrderId ?? order.supplier_order_id : order.supplier_order_id;
  const now = svc.now().getTime();
  const review = order.delivery === "review";

  await svc.db.tx(async (db) => {
    // Re-read under lock: another worker or a webhook may have finished it.
    const locked = await one<{ status: string }>(db, `select status from app.orders where id = $1 for update`, [order.id]);
    if (!locked || !["paid", "processing"].includes(locked.status)) return;

    // Anything the supplier already handed over (a phone number for SMS orders, codes) is stored.
    const items = result.status === "failed" ? [] : result.items ?? [];
    for (const item of items) {
      const exists = await one(db, `select 1 from app.deliveries where order_id = $1 and kind = $2 and label is not distinct from $3`, [
        order.id, item.kind, item.label ?? null,
      ]);
      if (exists && item.kind === "phone") continue;
      await db.query(`insert into app.deliveries (order_id, kind, value_enc, label) values ($1, $2, $3, $4)`, [
        order.id, item.kind, await encryptText(item.value, env.DATA_KEY), item.label ?? null,
      ]);
    }

    switch (step.next) {
      case "delivered":
        if (review) {
          // Bought: a person checks it before the customer gets it.
          await db.query(
            `update app.orders set status = 'processing', hold = 'release', supplier_order_id = $2, next_check_at = null,
                    cost_cents = coalesce($3, cost_cents), attempts = attempts + 1, last_error = null where id = $1`,
            [order.id, supplierOrderId, result.status === "delivered" ? result.costCents ?? null : null],
          );
          await db.query(`insert into app.order_events (order_id, type) values ($1, 'held_for_review')`, [order.id]);
          break;
        }
        await db.query(
          `update app.orders set status = 'delivered', delivered_at = now(), supplier_order_id = $2, next_check_at = null,
                  cost_cents = coalesce($3, cost_cents), attempts = attempts + 1, last_error = null where id = $1`,
          [order.id, supplierOrderId, result.status === "delivered" ? result.costCents ?? null : null],
        );
        await db.query(`insert into app.order_events (order_id, type) values ($1, 'delivered')`, [order.id]);
        await db.query(`insert into app.outbox (user_id, template, data) values ($1, 'order_delivered', $2::text::jsonb)`, [
          order.user_id, JSON.stringify({ order_id: order.id, number: n(order.number) }),
        ]);
        break;
      case "processing": {
        // A virtual number lasts a few minutes: check it often while it lives.
        const expires = result.status === "pending" && result.expiresAt && !Number.isNaN(Date.parse(result.expiresAt)) ? result.expiresAt : null;
        const after = expires || order.supplier_expires_at ? Math.min(step.checkAfterSeconds, 15) : step.checkAfterSeconds;
        await db.query(
          `update app.orders set status = 'processing', supplier_order_id = $2, attempts = attempts + 1,
                  next_check_at = to_timestamp($3::double precision / 1000), last_error = null,
                  supplier_expires_at = coalesce($4::timestamptz, supplier_expires_at) where id = $1`,
          [order.id, supplierOrderId, now + after * 1000, expires],
        );
        break;
      }
      case "retry":
        await db.query(
          `update app.orders set attempts = attempts + 1, last_error = $2,
                  next_check_at = to_timestamp($3::double precision / 1000) where id = $1`,
          [order.id, step.reason.slice(0, 500), now + step.checkAfterSeconds * 1000],
        );
        await db.query(`insert into app.order_events (order_id, type, data) values ($1, 'retry', $2::text::jsonb)`, [
          order.id, JSON.stringify({ reason: step.reason }),
        ]);
        break;
      case "refund":
        await db.query(`update app.orders set status = 'failed', last_error = $2, attempts = attempts + 1 where id = $1`, [
          order.id, step.reason.slice(0, 500),
        ]);
        await call(db, `select * from app.refund_order($1, $2)`, [order.id, step.reason]);
        if (isOutOfStock(result)) {
          await db.query(`update app.offers set paused_reason = 'supplier_unavailable' where id = $1 and paused_reason is null`, [order.offer_id]);
        }
        break;
    }
  });
  if (review && step.next === "delivered") {
    await alertStaff(svc, `Order ${store.orderPrefix}${n(order.number)} (${order.name_en}) was delivered by the supplier: check it and release it in Admin → Orders → Waiting.`, ["owner", "support"]);
  }
  return step.next;
}

/** Check customer input against the offer's field rules before charging anything. */
export function validateInput(
  fields: InputField[],
  input: Record<string, unknown>,
): { ok: true; values: Record<string, string> } | { ok: false; field: string } {
  // A plain map: field names are the supplier's own and must never reach Object internals.
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const f of fields) {
    const raw = Object.hasOwn(input, f.key) ? input[f.key] : undefined;
    const v = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (!v) {
      if (f.required) return { ok: false, field: f.key };
      continue;
    }
    if (v.length > 200) return { ok: false, field: f.key };
    if (f.options?.length && !f.options.some((o) => o.value === v)) return { ok: false, field: f.key };
    if (f.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(f.pattern);
      } catch {
        return { ok: false, field: f.key };
      }
      if (!re.test(v)) return { ok: false, field: f.key };
    }
    values[f.key] = v;
  }
  return { ok: true, values };
}
