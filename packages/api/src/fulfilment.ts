/**
 * Getting a paid order from the supplier to the customer.
 *
 * Called right after an order is placed (in the background) and again by the
 * scheduled job for orders that are pending or failed with a retryable error.
 * Delivered values are encrypted before they are stored.
 *
 * One caller at a time: fulfilOrder first takes the order's lease
 * (orders.lease_until, migration 0030) in one atomic update, so the order page,
 * the scheduled job, webhooks and the admin can never buy the same order twice.
 *
 * A product set to "review" (products.delivery) is bought as usual, but what the
 * supplier delivers waits (orders.hold = 'release') until a person checks it
 * and releases it in Admin → Orders.
 *
 * A purchase the supplier can't complete (out of stock, out of balance, an
 * error after the retries) waits for the owner (orders.hold = 'owner'): they
 * buy it elsewhere and deliver it by hand in Admin → Orders → Waiting, or
 * refund it. With orders.failed_to_owner off, and always for virtual numbers,
 * it is refunded at once. Out of stock also stops the package selling
 * (paused as "supplier_unavailable") until the price check sees stock again.
 * Only failures in a row count (orders.fail_streak), and an order the supplier
 * already accepted is never refunded for a passing error.
 */
import { backoffSeconds, encryptText, nextStep, type InputField, type PurchaseResult } from "@store/core";
import type { ApiEnv, Services } from "./context";
import { call, n, one } from "./db";
import { alertStaff } from "./notify";
import { readSettings } from "./settings";
import { settingValue } from "./settings-registry";
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
  fail_streak: number;
  lease_until: string | Date;
  supplier_ref: string | null;
  offer_cost_cents: string | number | null;
  supplier_expires_at: string | Date | null;
  delivery: string;
  name_en: string;
  kind: string;
  hold: string | null;
}

/** How long one run holds an order while it asks the supplier (longer than any supplier call). */
export const ORDER_LEASE = "2 minutes";

/** The supplier said it has none left (wording varies by supplier). */
export function isOutOfStock(result: PurchaseResult): boolean {
  return result.status === "failed" && (result.code === "out_of_stock" || /out of stock|no free (numbers|phones)|sold out/i.test(result.reason));
}

const isOpen = (status: string) => status === "paid" || status === "processing";

/**
 * Ask the supplier about an order (buy it, or check on it) and record the answer.
 * An order another caller holds right now is left to them ("busy"). Returns the
 * next step, or the order's status when there was nothing to do.
 */
export async function fulfilOrder(svc: Services, env: ApiEnv, orderId: string): Promise<string> {
  const order = await one<OrderRow>(
    svc.db,
    `with taken as (
       update app.orders set lease_until = date_trunc('milliseconds', now()) + interval '${ORDER_LEASE}'
        where id = $1 and status in ('paid', 'processing') and hold is null and supplier_id is not null
          and (lease_until is null or lease_until <= now())
        returning *)
     select o.id, o.number, o.user_id, o.offer_id, o.status, o.quantity, o.input, o.supplier_id, o.supplier_order_id, o.attempts, o.fail_streak,
            o.lease_until, o.supplier_expires_at, o.hold, f.supplier_ref, f.cost_cents as offer_cost_cents, p.delivery, p.name_en, p.kind
       from taken o join app.offers f on f.id = o.offer_id join app.products p on p.id = o.product_id`,
    [orderId],
  );
  if (!order) {
    // Closed, waiting for someone (hold), sold by hand, or another run has it right now.
    const now = await one<{ status: string; hold: string | null; supplier_id: string | null }>(
      svc.db, `select status, hold, supplier_id from app.orders where id = $1`, [orderId],
    );
    if (!now) return "missing";
    return isOpen(now.status) && !now.hold && now.supplier_id ? "busy" : now.status;
  }
  try {
    return await fulfilLeased(svc, env, order);
  } finally {
    // Whatever happened, the next caller may ask again (the steps below already free it).
    await svc.db
      .query(`update app.orders set lease_until = null where id = $1 and lease_until = $2::timestamptz`, [order.id, order.lease_until])
      .catch((e) => console.error("could not free order", order.id, String(e)));
  }
}

async function fulfilLeased(svc: Services, env: ApiEnv, order: OrderRow): Promise<string> {
  const adapter = svc.supplier(order.supplier_id ?? "");
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

  // An order the supplier accepted keeps its supplier_order_id, so the next run asks
  // checkOrder instead of buying again, and a retryable failure then never refunds it
  // (the supplier may still deliver). Purchases pass our order id as the idempotency
  // key where the supplier supports one.
  const supplierOrderId = ("supplierOrderId" in result ? result.supplierOrderId : undefined) ?? order.supplier_order_id;
  let step = nextStep(result, order.attempts, { failures: order.fail_streak, accepted: !!supplierOrderId });
  const now = svc.now().getTime();
  const review = order.delivery === "review";

  // A virtual number that failed for good is released at the supplier before the
  // refund (as when the customer cancels it), so the store is not charged for it.
  if (step.next === "refund" && order.kind === "sms" && supplierOrderId && adapter?.cancel) {
    try {
      await adapter.cancel(supplierOrderId);
    } catch (err) {
      step = {
        next: "retry",
        checkAfterSeconds: backoffSeconds(order.fail_streak),
        reason: `could not release the number: ${err instanceof Error ? err.message.slice(0, 150) : "error"}`,
      };
    }
  }

  // Can't be bought: the owner finishes it by hand (not a virtual number: it lives minutes).
  const toOwner = step.next === "refund" && order.kind !== "sms" &&
    settingValue(await readSettings(svc.db, ["orders.failed_to_owner"]), "orders.failed_to_owner");
  // What the supplier charged, when it says (a reported 0 tells nothing: the known cost stays).
  const cost = result.status !== "failed" && typeof result.costCents === "number" && result.costCents > 0 ? result.costCents : null;

  const applied = await svc.db.tx(async (db) => {
    // Re-read under lock: another worker, a webhook or a person may have finished it,
    // put it on hold, or (after an expired lease) bought it already.
    const locked = await one<{ status: string; hold: string | null; supplier_order_id: string | null }>(
      db, `select status, hold, supplier_order_id from app.orders where id = $1 for update`, [order.id],
    );
    if (!locked || !isOpen(locked.status) || locked.hold !== null || locked.supplier_order_id !== order.supplier_order_id) {
      if (locked && locked.supplier_order_id !== order.supplier_order_id) {
        await db.query(`insert into app.order_events (order_id, type, data) values ($1, 'fulfil_conflict', $2::text::jsonb)`, [
          order.id, JSON.stringify({ ours: supplierOrderId ?? null, theirs: locked.supplier_order_id }),
        ]);
      }
      return false;
    }

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
            `update app.orders set status = 'processing', hold = 'release', supplier_order_id = $2, next_check_at = null, lease_until = null,
                    cost_cents = coalesce($3, cost_cents), attempts = attempts + 1, fail_streak = 0, last_error = null where id = $1`,
            [order.id, supplierOrderId, cost],
          );
          await db.query(`insert into app.order_events (order_id, type) values ($1, 'held_for_review')`, [order.id]);
          break;
        }
        await db.query(
          `update app.orders set status = 'delivered', delivered_at = now(), supplier_order_id = $2, next_check_at = null, lease_until = null,
                  cost_cents = coalesce($3, cost_cents), attempts = attempts + 1, fail_streak = 0, last_error = null where id = $1`,
          [order.id, supplierOrderId, cost],
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
          `update app.orders set status = 'processing', supplier_order_id = $2, attempts = attempts + 1, fail_streak = 0, lease_until = null,
                  next_check_at = to_timestamp($3::double precision / 1000), last_error = null,
                  supplier_expires_at = coalesce($4::timestamptz, supplier_expires_at) where id = $1`,
          [order.id, supplierOrderId, now + after * 1000, expires],
        );
        break;
      }
      case "retry": {
        // A live virtual number is still checked often, whatever the backoff says.
        const after = order.kind === "sms" && supplierOrderId ? Math.min(step.checkAfterSeconds, 30) : step.checkAfterSeconds;
        await db.query(
          `update app.orders set attempts = attempts + 1, fail_streak = fail_streak + 1, last_error = $2, lease_until = null,
                  supplier_order_id = coalesce($4, supplier_order_id),
                  next_check_at = to_timestamp($3::double precision / 1000) where id = $1`,
          [order.id, step.reason.slice(0, 500), now + after * 1000, supplierOrderId],
        );
        await db.query(`insert into app.order_events (order_id, type, data) values ($1, 'retry', $2::text::jsonb)`, [
          order.id, JSON.stringify({ reason: step.reason }),
        ]);
        break;
      }
      case "refund":
        if (toOwner) {
          await db.query(
            `update app.orders set hold = 'owner', last_error = $2, attempts = attempts + 1, fail_streak = fail_streak + 1,
                    next_check_at = null, lease_until = null where id = $1`,
            [order.id, step.reason.slice(0, 500)],
          );
          await db.query(`insert into app.order_events (order_id, type, data) values ($1, 'held_supplier_failed', $2::text::jsonb)`, [
            order.id, JSON.stringify({ reason: step.reason }),
          ]);
        } else {
          await db.query(
            `update app.orders set status = 'failed', last_error = $2, attempts = attempts + 1, fail_streak = fail_streak + 1, lease_until = null where id = $1`,
            [order.id, step.reason.slice(0, 500)],
          );
          await call(db, `select * from app.refund_order($1, $2)`, [order.id, step.reason]);
        }
        if (isOutOfStock(result)) {
          await db.query(`update app.offers set paused_reason = 'supplier_unavailable' where id = $1 and paused_reason is null`, [order.offer_id]);
        }
        break;
    }
    return true;
  });
  if (!applied) return "busy";
  if (toOwner) {
    await alertStaff(
      svc,
      `Order ${store.orderPrefix}${n(order.number)} (${order.name_en}) couldn't be bought from ${order.supplier_id}: ${step.next === "refund" ? step.reason.slice(0, 160) : ""}. Deliver it by hand in Admin → Orders → Waiting, or refund it.`,
      ["owner", "support"],
    );
  }
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
