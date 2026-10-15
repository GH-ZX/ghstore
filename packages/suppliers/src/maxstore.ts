/**
 * MaxStore — game top-ups, numbers, social-media services and codes.
 *
 * JSON at https://maxstore1.com/api/v2, token in the `api-token` header.
 * Limits: 60 calls/minute, orders 30/minute (429 + Retry-After).
 *
 * Quirks worth knowing:
 * - Failures are `{ detail: { code, message } }`; the code is more precise
 *   than the HTTP status: 100 balance, 105 quantity unavailable, 106 missing
 *   field, 109 product gone, 110 product unavailable, 111 too many requests,
 *   114 unknown, 120-123 token/permission/IP blocked, 130 maintenance.
 *   120-123 must never be retried (MaxStore blocks the IP).
 * - The product list has been seen bare and wrapped (`products`, `data`,
 *   `data.products`, `data.items`) and renames fields freely, so it is read
 *   permissively. `params` is a list of (often Arabic) field names;
 *   `params_meta`, when present, is the richer definition and wins.
 *   `product_type: "package"` fixes quantity at 1; `qty_values` holds min/max.
 * - POST /order needs `order_uuid` (a UUIDv4) as its idempotency key; our key
 *   is used when it is a v4 UUID, otherwise a v4-shaped UUID is derived from it.
 *   Order status is accept / wait / reject. Only `reject` is a failure.
 * - GET /check?orders=<uuid,...> (max 50) reports status and `delivery`, so the
 *   supplierOrderId is our order_uuid. There is no webhook.
 * - Prices and balance are treated as USD (as the store's importer did).
 *
 * externalId: MaxStore product id. supplierOrderId: the order_uuid we sent.
 *
 * Config: MAXSTORE_API_KEY, MAXSTORE_BASE_URL (default https://maxstore1.com).
 */
import { AdapterError } from "../../core/src/adapters";
import type {
  AdapterContext, DeliveredItem, InputField, PurchaseResult, SupplierAdapter, SupplierProduct,
} from "../../core/src/adapters";
import {
  arr, baseUrl, caught, cfg, deliveryValues, failed, http, httpFailure, isObj, itemsFrom, num, numericOr, obj,
  str, supplierMessage, usdToCents, uuid4From, type HttpOptions, type HttpResult, type Obj,
} from "./shared";

const ID = "maxstore";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Map a MaxStore `detail.code` (or, lacking one, the HTTP status) to a failure. */
function classifyFailure(r: HttpResult, message: string): { retryable: boolean; reason: string } {
  const code = num(obj(obj(r.json)?.detail)?.code);
  if (code === null) return httpFailure(r.status, message);
  if (code === 100) return { retryable: true, reason: `supplier wallet balance too low: ${message}` };
  if (code >= 120 && code <= 123) return { retryable: false, reason: `supplier rejected the API token (code ${code})` };
  if (code === 111 || code === 114 || code === 130) return { retryable: true, reason: `supplier temporarily unavailable (code ${code}): ${message}` };
  if (code === 105 || code === 110) return { retryable: false, reason: `out of stock at supplier: ${message}` };
  return { retryable: false, reason: `${message} (code ${code})` };
}

function productList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const body = obj(json);
  const data = body?.data;
  if (Array.isArray(body?.products)) return body.products;
  if (Array.isArray(data)) return data;
  return arr(obj(data)?.products).length ? arr(obj(data)?.products) : arr(obj(data)?.items);
}

function fieldsOf(p: Obj): { fields: InputField[]; options: Record<string, unknown[]> } {
  const options: Record<string, unknown[]> = {};
  const fromMeta = arr(p.params_meta).filter(isObj).flatMap((m): InputField[] => {
    const key = str(m.key) ?? str(m.name) ?? str(m.field_key);
    if (!key) return [];
    if (Array.isArray(m.options) && m.options.length) options[key] = m.options;
    return [{
      key,
      labelEn: str(m.label_en) ?? str(m.label) ?? str(m.name) ?? key,
      labelAr: str(m.label_ar) ?? str(m.label) ?? str(m.name) ?? key,
      required: m.required !== false,
    }];
  });
  if (fromMeta.length) return { fields: fromMeta, options };
  const names = Array.isArray(p.params)
    ? p.params.map((e) => (typeof e === "string" ? e.trim() : str(obj(e)?.name) ?? str(obj(e)?.key) ?? ""))
    : isObj(p.params) ? Object.keys(p.params) : [];
  return { fields: names.filter(Boolean).map((k) => ({ key: k, labelEn: k, labelAr: k, required: true })), options };
}

function readAvailable(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") return ["1", "true", "yes"].includes(value.trim().toLowerCase());
  return true; // undocumented shape: do not hide a live product
}

function classify(status: unknown): "completed" | "failed" | "pending" {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "accept" || s === "accepted" || s === "success") return "completed";
  if (s === "reject" || s === "rejected" || s === "failed") return "failed";
  return "pending"; // "wait" and anything unknown: refunding would give the goods away
}

export function createMaxStore(ctx: AdapterContext): SupplierAdapter {
  const base = baseUrl(ctx, "MAXSTORE_BASE_URL", "https://maxstore1.com");
  const key = cfg(ctx, "MAXSTORE_API_KEY");
  const secrets = key ? [key] : [];

  async function call(path: string, opts: HttpOptions = {}): Promise<HttpResult> {
    if (!key) throw new AdapterError(ID, "MAXSTORE_API_KEY is not configured");
    return http(ctx, ID, `${base}/api/v2${path}`, { ...opts, headers: { "api-token": key }, secrets });
  }

  async function read(path: string): Promise<unknown> {
    const r = await call(path);
    if (!r.ok) {
      const f = classifyFailure(r, supplierMessage(r, secrets));
      throw new AdapterError(ID, f.reason, f.retryable);
    }
    return r.json;
  }

  /** Turn a /check row (or the order response) into a result. */
  function settle(supplierOrderId: string, row: Obj | undefined, fallbackFields: Record<string, string> = {}): PurchaseResult {
    const state = classify(row?.status);
    if (state === "failed") return failed("MaxStore rejected the order", false, supplierOrderId);
    if (state === "pending") return { status: "pending", supplierOrderId };
    const items: DeliveredItem[] = itemsFrom(deliveryValues(row?.delivery), "code");
    if (items.length === 0) {
      // A top-up delivers nothing but the account it landed on.
      const target = Object.values(obj(row?.data) ?? fallbackFields).map(str).find(Boolean);
      if (target) items.push({ kind: "id", value: target });
    }
    const cost = usdToCents(row?.price);
    return { status: "delivered", supplierOrderId, items, ...(cost !== null ? { costCents: cost } : {}) };
  }

  async function lookup(uuid: string): Promise<Obj | undefined> {
    const rows = arr(obj(await read(`/check?orders=${encodeURIComponent(uuid)}`))?.data).filter(isObj);
    return rows.find((row) => str(row.order_id) === uuid) ?? (rows.length === 1 ? rows[0] : undefined);
  }

  const adapter: SupplierAdapter = {
    id: ID,
    name: "MaxStore",

    async listProducts() {
      return productList(await read("/products")).filter(isObj).flatMap((p): SupplierProduct[] => {
        const id = str(p.id);
        const cost = usdToCents(p.price);
        if (!id || cost === null) return [];
        const { fields, options } = fieldsOf(p);
        const productType = str(p.product_type)?.toLowerCase() ?? null;
        const stock = num(p.stock_count ?? p.stockCount ?? p.stock ?? p.inventory ?? p.quantity_available);
        const category = obj(p.category);
        const qty = obj(p.qty_values);
        const fixed = productType === "package";
        return [{
          externalId: id,
          name: str(p.name) ?? str(p.title) ?? str(p.product_name) ?? id,
          costCents: cost,
          available: readAvailable(p.available) && (stock === null || stock > 0),
          kind: productType === "voucher" ? "code" : fields.length > 0 ? "id" : "code",
          ...(fields.length > 0 ? { fields } : {}),
          meta: {
            productType, stock,
            categoryId: str(p.category_id) ?? str(p.categoryId) ?? str(category?.id) ?? null,
            category: str(p.category_title) ?? str(p.category_name) ?? str(p.categoryTitle)
              ?? (typeof p.category === "string" ? p.category : str(category?.name) ?? str(category?.title)) ?? null,
            qtyMin: fixed ? 1 : num(qty?.min) ?? 1,
            qtyMax: fixed ? 1 : num(qty?.max),
            fieldOptions: options,
            image: str(p.image_url) ?? str(p.image) ?? str(p.img) ?? str(p.photo) ?? null,
            description: str(p.description) ?? str(p.desc) ?? str(p.details) ?? str(p.instructions) ?? str(p.note) ?? null,
          },
        }];
      });
    },

    async getBalance() {
      const balance = usdToCents(obj(await read("/profile"))?.balance);
      if (balance === null) throw new AdapterError(ID, "/profile returned no readable balance");
      return { amountCents: balance, currency: "USD" };
    },

    async purchase(req) {
      try {
        if (!key) return failed("MAXSTORE_API_KEY is not configured", false);
        const uuid = UUID_V4.test(req.idempotencyKey) ? req.idempotencyKey : await uuid4From(req.idempotencyKey);
        const hasParams = Object.keys(req.fields).length > 0;
        const r = await call("/order", {
          method: "POST",
          body: {
            product_id: numericOr(req.externalId),
            qty: Math.max(1, Math.floor(req.quantity)),
            order_uuid: uuid,
            ...(hasParams ? { params: req.fields } : {}),
          },
        });
        const detail = obj(r.json)?.detail;
        if (!r.ok || (detail !== undefined && detail !== null)) {
          const f = classifyFailure(r.ok ? { ...r, status: 400 } : r, supplierMessage(r, secrets));
          return failed(f.reason, f.retryable);
        }
        const order = obj(obj(r.json)?.data);
        if (classify(order?.status) !== "completed") return settle(uuid, order);
        // Accepted at once: fetch the delivery (codes live on /check, not on the order).
        const row = await lookup(uuid).catch(() => undefined);
        return settle(uuid, row && classify(row.status) === "completed" ? { ...order, ...row } : order, req.fields);
      } catch (err) {
        return caught(err);
      }
    },

    async checkOrder(supplierOrderId) {
      const row = await lookup(supplierOrderId);
      return row ? settle(supplierOrderId, row) : { status: "pending", supplierOrderId };
    },
  };
  return adapter;
}
