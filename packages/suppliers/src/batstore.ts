/**
 * BatStore (VenteBot reseller API) — accounts, codes and activations sold from
 * a Telegram-bot reseller wallet.
 *
 * Every route lives under /api/reseller/ on the BatStore host (a Railway
 * deployment URL, hence overridable). The key travels in `X-Reseller-Key`.
 *
 * Quirks worth knowing:
 * - GET /products answers `{ success, products }` although the swagger shows a
 *   bare array; both are accepted. `api_test: true` (and id 2147483000) is
 *   BatStore's synthetic test product and is never listed.
 * - Sellable only with a positive `stock`; a missing count means unknown, which
 *   is treated as not sellable (BatStore's own rule, from live imports).
 * - `delivery_type: "stock"` goods are delivered as-is in items[].account_data;
 *   "supplier_api" / "activation" goods are activated on an
 *   `activation_identifier` the buyer supplies (Telegram ID, email...).
 * - POST /orders is idempotent on `idempotency_key`; reusing a key with a
 *   different body answers 409. 402 means our reseller wallet is too low.
 *   Failures are `{ success: false, code, message }`.
 * - Order statuses: COMPLETED, PAID_PENDING_DELIVERY, AWAITING_ACTIVATION_INFO,
 *   AWAITING_ACTIVATION, CANCELLED. Items present on the order mean delivered
 *   whatever the status says.
 * - An optional secondary mirror is tried on network errors and 502/503/504.
 * - BatStore documents no order callback; the old bot's generic shared-secret
 *   receiver (re-reads the order, never trusts the body) is kept as parseWebhook.
 *
 * externalId: BatStore product id. supplierOrderId: BatStore order id.
 *
 * Config: BATSTORE_API_KEY, BATSTORE_BASE_URL (default
 * https://ventetelegrambotrailway-production.up.railway.app),
 * BATSTORE_BASE_URL_SECONDARY (optional mirror), BATSTORE_WEBHOOK_SECRET
 * (falls back to SUPPLIER_WEBHOOK_SECRET).
 */
import { AdapterError } from "../../core/src/adapters";
import type { AdapterContext, DeliveredItem, InputField, PurchaseResult, SupplierAdapter, SupplierProduct } from "../../core/src/adapters";
import {
  arr, baseUrl, caught, cfg, deliveryValues, failed, http, httpError, isObj, itemsFrom, num, numericOr, obj,
  pick, refusal, str, supplierMessage, usdToCents, wakeUpWebhook, webhookSecret,
  type HttpOptions, type HttpResult, type Obj,
} from "./shared";

const ID = "batstore";
const TEST_PRODUCT_ID = "2147483000";
const MIRROR_STATUSES = new Set([502, 503, 504]);

const ACTIVATION_FIELD: InputField = {
  key: "activation_identifier",
  labelEn: "Activation ID (Telegram ID, email or account)",
  labelAr: "معرّف التفعيل (معرّف تيليجرام أو البريد أو الحساب)",
  required: true,
};

function classify(status: unknown, hasItems: boolean): "completed" | "failed" | "pending" {
  if (hasItems) return "completed";
  const s = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (s === "COMPLETED" || s === "DELIVERED" || s === "FULFILLED") return "completed";
  if (["CANCELLED", "CANCELED", "FAILED", "REFUNDED", "REJECTED", "ERROR", "EXPIRED"].includes(s)) return "failed";
  return "pending";
}

/** The order object, whether wrapped in `{ success, order }` or sent bare. */
function orderOf(json: unknown): Obj | undefined {
  const body = obj(json);
  return obj(body?.order) ?? (body && body.id !== undefined ? body : undefined);
}

function productList(json: unknown): unknown[] {
  return Array.isArray(json) ? json : arr(obj(json)?.products);
}

export function createBatStore(ctx: AdapterContext): SupplierAdapter {
  const base = baseUrl(ctx, "BATSTORE_BASE_URL", "https://ventetelegrambotrailway-production.up.railway.app");
  const secondary = cfg(ctx, "BATSTORE_BASE_URL_SECONDARY")?.replace(/\/+$/, "");
  const key = cfg(ctx, "BATSTORE_API_KEY");
  const secrets = key ? [key] : [];

  async function call(path: string, opts: HttpOptions = {}): Promise<HttpResult> {
    if (!key) throw new AdapterError(ID, "BATSTORE_API_KEY is not configured");
    const full = { ...opts, headers: { "X-Reseller-Key": key }, secrets };
    try {
      const r = await http(ctx, ID, base + path, full);
      if (!secondary || !MIRROR_STATUSES.has(r.status)) return r;
    } catch (err) {
      if (!secondary) throw err;
    }
    return http(ctx, ID, secondary + path, full);
  }

  async function read(path: string): Promise<unknown> {
    const r = await call(path);
    if (!r.ok) throw httpError(ID, r, secrets);
    if (obj(r.json)?.success === false) throw new AdapterError(ID, `${path} failed: ${supplierMessage(r, secrets)}`);
    return r.json;
  }

  function orderResult(order: Obj | undefined, fallbackId: string | undefined, identifier?: string): PurchaseResult {
    const supplierOrderId = str(order?.id) ?? fallbackId;
    if (!order || !supplierOrderId) return failed("BatStore answered without an order; supplier state unknown", true);
    const values = deliveryValues(order.items);
    const state = classify(order.status, values.length > 0);
    if (state === "failed") return failed("BatStore cancelled the order", false, supplierOrderId);
    if (state === "pending") return { status: "pending", supplierOrderId };
    const items: DeliveredItem[] = itemsFrom(values, "account");
    const activatedOn = str(order.activation_identifier) ?? identifier;
    if (items.length === 0 && activatedOn) items.push({ kind: "id", value: activatedOn });
    const cost = usdToCents(order.amount_usd);
    return { status: "delivered", supplierOrderId, items, ...(cost !== null ? { costCents: cost } : {}) };
  }

  const adapter: SupplierAdapter = {
    id: ID,
    name: "BatStore",

    async listProducts() {
      const products = productList(await read("/api/reseller/products"));
      // Arabic descriptions come from a second, best-effort call (as the old sync did).
      const arabic = new Map<string, string>();
      try {
        for (const p of productList(await read("/api/reseller/products?lang=ar")).filter(isObj)) {
          const id = str(p.id);
          const description = str(p.description);
          if (id && description) arabic.set(id, description);
        }
      } catch {
        // Missing translations never block a sync.
      }
      return products.filter(isObj).flatMap((p): SupplierProduct[] => {
        const id = str(p.id);
        const cost = usdToCents(p.price_usd);
        if (!id || id === TEST_PRODUCT_ID || p.api_test === true || cost === null) return [];
        const stock = num(p.stock);
        const deliveryType = str(p.delivery_type)?.toLowerCase() ?? "stock";
        const direct = deliveryType === "stock";
        const tiers = arr(p.price_tiers).filter(isObj).map((t) => ({
          minQty: num(t.min_qty), maxQty: num(t.max_qty), costCents: usdToCents(t.price_usd),
        }));
        return [{
          externalId: id,
          name: str(p.name) ?? `Product ${id}`,
          costCents: cost,
          available: stock !== null && stock > 0,
          kind: direct ? "account" : "id",
          ...(direct ? {} : { fields: [ACTIVATION_FIELD] }),
          meta: {
            deliveryType, stock, tiers, description: str(p.description) ?? null, descriptionAr: arabic.get(id) ?? null,
            emoji: str(p.emoji) ?? null, image: str(p.image_url) ?? null, warrantyDays: num(p.warranty_days),
            standardPriceCents: usdToCents(p.standard_price_usd), pricingType: str(p.pricing_type) ?? null,
          },
        }];
      });
    },

    async getBalance() {
      const me = obj(await read("/api/reseller/me"));
      const balance = usdToCents(me?.wallet_balance ?? obj(me?.wallet)?.balance);
      if (balance === null) throw new AdapterError(ID, "/me returned no readable balance");
      return { amountCents: balance, currency: "USD" };
    },

    async purchase(req) {
      try {
        if (!key) return failed("BATSTORE_API_KEY is not configured", false);
        const identifier = pick(req.fields, "activation_identifier", "activationIdentifier");
        const r = await call("/api/reseller/orders", {
          method: "POST",
          body: {
            product_id: numericOr(req.externalId),
            quantity: Math.max(1, Math.floor(req.quantity)),
            // Omitted for direct goods: an empty identifier is not the same as none.
            ...(identifier ? { activation_identifier: identifier } : {}),
            customer_reference: req.idempotencyKey,
            idempotency_key: req.idempotencyKey,
          },
        });
        const message = () => supplierMessage(r, secrets);
        if (r.status === 409 && !/stock/i.test(message())) {
          return failed(`BatStore refused a reused idempotency key: ${message()}`, false);
        }
        if (!r.ok) return refusal(r.status, message());
        if (obj(r.json)?.success === false) return refusal(400, message());
        return orderResult(orderOf(r.json), undefined, identifier);
      } catch (err) {
        return caught(err);
      }
    },

    async checkOrder(supplierOrderId) {
      const r = await call(`/api/reseller/orders/${encodeURIComponent(supplierOrderId)}`);
      if (r.status === 404) throw new AdapterError(ID, `order ${supplierOrderId} not found at BatStore`);
      if (!r.ok) throw httpError(ID, r, secrets);
      if (obj(r.json)?.success === false) throw new AdapterError(ID, `order lookup failed: ${supplierMessage(r, secrets)}`);
      return orderResult(orderOf(r.json), supplierOrderId);
    },

    async parseWebhook(req) {
      return wakeUpWebhook(req, {
        secret: webhookSecret(ctx, "BATSTORE_WEBHOOK_SECRET"),
        orderRef: (body) => str(body.order_id) ?? str(body.id) ?? str(body.external_id) ?? null,
        check: (id) => adapter.checkOrder(id),
      });
    },
  };
  return adapter;
}
