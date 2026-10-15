/**
 * ProdSeller — digital keys, invites and subscriptions paid from a USDT wallet.
 *
 * JSON at https://prodseller.com/v1, key in `X-API-Key` (keys look like psk_...).
 *
 * Quirks worth knowing:
 * - Product ids are 24-character MongoDB ids; prices are plain USD(T) numbers.
 *   `inStock` defaults to true when absent (old sync rule).
 * - POST /orders takes an `Idempotency-Key` header (max 100 chars) and body
 *   `{ productId, quantity }`. 409 means out of stock (not an idempotency
 *   conflict), 402 means our wallet is too low, and a 2xx body can still carry
 *   `{ error }`. Error wording is sometimes French (rupture / épuisé / solde).
 * - Delivery is `deliveredKey` and/or `deliveredKeys[]` (often invite URLs).
 *   Statuses: completed / delivered / success / active → done;
 *   failed / canceled / cancelled / rejected → failed; anything else pending.
 * - The wallet is USDT; balances are reported as USD 1:1.
 * - No documented order callback; the old bot's generic shared-secret receiver
 *   (re-reads the order, never trusts the body) is kept as parseWebhook.
 *
 * externalId: ProdSeller (Mongo) product id. supplierOrderId: ProdSeller order id.
 *
 * Config: PRODSELLER_API_KEY, PRODSELLER_BASE_URL (default https://prodseller.com/v1),
 * PRODSELLER_WEBHOOK_SECRET (falls back to SUPPLIER_WEBHOOK_SECRET).
 */
import { AdapterError } from "../../core/src/adapters";
import type { AdapterContext, PurchaseResult, SupplierAdapter, SupplierProduct } from "../../core/src/adapters";
import {
  arr, baseUrl, caught, cfg, deliveryValues, failed, http, httpError, isObj, itemsFrom, obj, refusal, str,
  supplierMessage, usdToCents, wakeUpWebhook, webhookSecret, type HttpOptions, type HttpResult, type Obj,
} from "./shared";

const ID = "prodseller";

function classify(status: unknown, hasKeys: boolean): "completed" | "failed" | "pending" {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (hasKeys || ["completed", "delivered", "success", "active"].includes(s)) return "completed";
  if (["failed", "canceled", "cancelled", "rejected"].includes(s)) return "failed";
  return "pending";
}

/** deliveredKey first, then deliveredKeys, without duplicates (old bot rule). */
function deliveredKeys(order: Obj): string[] {
  return [...new Set([...deliveryValues(order.deliveredKey), ...deliveryValues(order.deliveredKeys)])];
}

export function createProdSeller(ctx: AdapterContext): SupplierAdapter {
  const base = baseUrl(ctx, "PRODSELLER_BASE_URL", "https://prodseller.com/v1");
  const key = cfg(ctx, "PRODSELLER_API_KEY");
  const secrets = key ? [key] : [];

  async function call(path: string, opts: HttpOptions = {}): Promise<HttpResult> {
    if (!key) throw new AdapterError(ID, "PRODSELLER_API_KEY is not configured");
    return http(ctx, ID, base + path, { ...opts, headers: { ...opts.headers, "X-API-Key": key }, secrets });
  }

  async function read(path: string): Promise<Obj | undefined> {
    const r = await call(path);
    if (!r.ok) throw httpError(ID, r, secrets);
    return obj(r.json);
  }

  function orderResult(order: Obj | undefined, fallbackId?: string): PurchaseResult {
    const supplierOrderId = str(order?.orderId) ?? str(order?.id) ?? fallbackId;
    if (!order || !supplierOrderId) return failed("ProdSeller answered without an order id; supplier state unknown", true);
    const keys = deliveredKeys(order);
    const state = classify(order.status, keys.length > 0);
    if (state === "failed") return failed("ProdSeller could not complete the order", false, supplierOrderId);
    if (state === "pending") return { status: "pending", supplierOrderId };
    return { status: "delivered", supplierOrderId, items: itemsFrom(keys, "code") };
  }

  const adapter: SupplierAdapter = {
    id: ID,
    name: "ProdSeller",

    async listProducts() {
      return arr((await read("/products"))?.products).filter(isObj).flatMap((p): SupplierProduct[] => {
        const id = str(p.id);
        const cost = usdToCents(p.price);
        if (!id || cost === null) return [];
        return [{
          externalId: id,
          name: str(p.name) ?? `ProdSeller ${id.slice(0, 6)}`,
          costCents: cost,
          available: p.inStock !== false,
          kind: "code",
          meta: {
            description: str(p.description) ?? null,
            image: str(p.imageUrl) ?? null,
            publicPriceCents: usdToCents(p.publicPrice),
          },
        }];
      });
    },

    async getBalance() {
      const balance = usdToCents((await read("/balance"))?.balance);
      if (balance === null) throw new AdapterError(ID, "/balance returned no readable balance");
      return { amountCents: balance, currency: "USD" };
    },

    async purchase(req) {
      try {
        if (!key) return failed("PRODSELLER_API_KEY is not configured", false);
        const r = await call("/orders", {
          method: "POST",
          headers: { "Idempotency-Key": req.idempotencyKey.slice(0, 100) },
          body: { productId: req.externalId, quantity: Math.max(1, Math.floor(req.quantity)) },
        });
        const body = obj(r.json);
        if (r.status === 409) return failed(`out of stock at supplier: ${supplierMessage(r, secrets)}`, false);
        if (!r.ok) return refusal(r.status, supplierMessage(r, secrets));
        if (body?.error !== undefined && body.error !== null) return refusal(400, supplierMessage(r, secrets));
        return orderResult(body);
      } catch (err) {
        return caught(err);
      }
    },

    async checkOrder(supplierOrderId) {
      const r = await call(`/orders/${encodeURIComponent(supplierOrderId)}`);
      if (r.status === 404) throw new AdapterError(ID, `order ${supplierOrderId} not found at ProdSeller`);
      if (!r.ok) throw httpError(ID, r, secrets);
      return orderResult(obj(obj(r.json)?.order) ?? obj(r.json), supplierOrderId);
    },

    async parseWebhook(req) {
      return wakeUpWebhook(req, {
        secret: webhookSecret(ctx, "PRODSELLER_WEBHOOK_SECRET"),
        orderRef: (body) => str(body.order_id) ?? str(body.id) ?? str(body.external_id) ?? null,
        check: (id) => adapter.checkOrder(id),
      });
    },
  };
  return adapter;
}
