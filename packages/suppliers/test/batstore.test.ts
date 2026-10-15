import { describe, expect, it } from "vitest";
import { createBatStore } from "../src/batstore";
import { context, json, networkError } from "./fake-fetch";

const KEY = "test-key";
const config = { BATSTORE_API_KEY: KEY };
const ORDERS = "/api/reseller/orders";

// Shapes follow docs/providers/batstore-api.md and the old bot's tests.
const products = {
  success: true,
  products: [
    { id: 16, name: "Canva Pro 1 Year", price_usd: "0.60", standard_price_usd: 1.2, delivery_type: "stock", stock: 5, warranty_days: 30, price_tiers: [{ min_qty: 5, max_qty: 9, price_usd: 0.55 }] },
    { id: 17, name: "Telegram Premium 3M", price_usd: 11.995, delivery_type: "activation", stock: 3 },
    { id: 18, name: "Sold out", price_usd: 2, delivery_type: "stock", stock: 0 },
    { id: 19, name: "Unknown stock", price_usd: 2, delivery_type: "supplier_api" },
    { id: 2147483000, name: "API test", price_usd: 0.01, stock: 99 },
    { id: 20, name: "Flagged test", price_usd: 0.01, stock: 99, api_test: true },
  ],
};

describe("batstore listProducts", () => {
  it("parses products, skips test items, converts to cents and adds the activation field", async () => {
    const { ctx, calls } = context(
      {
        "GET /api/reseller/products": json(products),
        "GET /api/reseller/products?lang=ar": json({ success: true, products: [{ id: 16, description: "وصف عربي" }] }),
      },
      config,
    );
    const list = await createBatStore(ctx).listProducts();
    expect(list.map((p) => [p.externalId, p.costCents, p.available, p.kind])).toEqual([
      ["16", 60, true, "account"],
      ["17", 1200, true, "id"],
      ["18", 200, false, "account"],
      ["19", 200, false, "id"],
    ]);
    expect(list[0]?.fields).toBeUndefined();
    expect(list[1]?.fields?.[0]).toMatchObject({ key: "activation_identifier", required: true });
    expect(list[0]?.meta).toMatchObject({ descriptionAr: "وصف عربي", warrantyDays: 30, standardPriceCents: 120, tiers: [{ minQty: 5, maxQty: 9, costCents: 55 }] });
    expect(calls[0]?.headers["x-reseller-key"]).toBe(KEY);
  });

  it("accepts a bare array and survives a failing Arabic call", async () => {
    const { ctx } = context(
      {
        "GET /api/reseller/products": json(products.products.slice(0, 1)),
        "GET /api/reseller/products?lang=ar": json({}, 500),
      },
      config,
    );
    expect((await createBatStore(ctx).listProducts()).map((p) => p.externalId)).toEqual(["16"]);
  });

  it("falls over to the secondary mirror on a 503", async () => {
    const { ctx, calls } = context(
      { "GET /api/reseller/me": [json({}, 503), json({ success: true, wallet_balance: "15.00" })] },
      { ...config, BATSTORE_BASE_URL: "https://primary.example", BATSTORE_BASE_URL_SECONDARY: "https://mirror.example/" },
    );
    expect(await createBatStore(ctx).getBalance()).toEqual({ amountCents: 1500, currency: "USD" });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["primary.example", "mirror.example"]);
  });
});

describe("batstore purchase", () => {
  const req = { externalId: "17", quantity: 1, fields: { activation_identifier: "@buyer" }, idempotencyKey: "order-1-line-0" };

  it("sends the documented body and returns delivered account data", async () => {
    const { ctx, calls } = context(
      {
        [`POST ${ORDERS}`]: json({
          success: true,
          status: "COMPLETED",
          order: { id: 777, status: "COMPLETED", amount_usd: 0.6, items: [{ id: 1, account_data: "user@mail.com:pa55" }, { id: 2, account_data: "https://invite.example/x" }] },
        }),
      },
      config,
    );
    expect(await createBatStore(ctx).purchase(req)).toEqual({
      status: "delivered",
      supplierOrderId: "777",
      items: [{ kind: "account", value: "user@mail.com:pa55" }, { kind: "link", value: "https://invite.example/x" }],
      costCents: 60,
    });
    expect(calls[0]?.body).toEqual({
      product_id: 17, quantity: 1, activation_identifier: "@buyer", customer_reference: "order-1-line-0", idempotency_key: "order-1-line-0",
    });
  });

  it("reports an activation that is still waiting as pending", async () => {
    const { ctx } = context({ [`POST ${ORDERS}`]: json({ success: true, order: { id: 778, status: "AWAITING_ACTIVATION", items: [] } }) }, config);
    expect(await createBatStore(ctx).purchase(req)).toEqual({ status: "pending", supplierOrderId: "778" });
  });

  it("omits activation_identifier for direct goods", async () => {
    const { ctx, calls } = context({ [`POST ${ORDERS}`]: json({ success: true, order: { id: 779, status: "PAID_PENDING_DELIVERY" } }) }, config);
    await createBatStore(ctx).purchase({ ...req, externalId: "16", fields: {} });
    expect(calls[0]?.body).not.toHaveProperty("activation_identifier");
  });

  it.each([
    [402, { success: false, code: "INSUFFICIENT_BALANCE", message: "Insufficient wallet balance" }, true, /balance too low/],
    [400, { success: false, code: "OUT_OF_STOCK", message: "Insufficient stock for product #16 (requested 1, available 0)" }, false, /out of stock/],
    [409, { success: false, code: "IDEMPOTENCY_CONFLICT", message: "Key reused with a different payload" }, false, /idempotency/],
    [422, { success: false, code: "VALIDATION", message: "activation_identifier is required" }, false, /activation_identifier/],
    [502, { success: false }, true, /server error/],
  ])("maps HTTP %i to a failure", async (status, body, retryable, reason) => {
    const { ctx } = context({ [`POST ${ORDERS}`]: json(body, status) }, config);
    const result = await createBatStore(ctx).purchase(req);
    expect(result).toMatchObject({ status: "failed", retryable });
    expect(result.status === "failed" && result.reason).toMatch(reason);
  });

  it("treats success:false in a 200 and a network error correctly", async () => {
    const refused = context({ [`POST ${ORDERS}`]: json({ success: false, message: "out of stock" }) }, config);
    expect(await createBatStore(refused.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: false });
    const down = context({ [`POST ${ORDERS}`]: networkError() }, config);
    expect(await createBatStore(down.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("batstore checkOrder", () => {
  it("maps order states", async () => {
    const { ctx } = context(
      {
        [`GET ${ORDERS}/777`]: [
          json({ success: true, order: { id: 777, status: "PAID_PENDING_DELIVERY", items: [] } }),
          json({ success: true, order: { id: 777, status: "COMPLETED", activation_identifier: "@buyer", items: [] } }),
          json({ success: true, order: { id: 777, status: "CANCELLED" } }),
        ],
        [`GET ${ORDERS}/404`]: json({ success: false, message: "not found" }, 404),
      },
      config,
    );
    const adapter = createBatStore(ctx);
    expect(await adapter.checkOrder("777")).toEqual({ status: "pending", supplierOrderId: "777" });
    expect(await adapter.checkOrder("777")).toEqual({ status: "delivered", supplierOrderId: "777", items: [{ kind: "id", value: "@buyer" }] });
    expect(await adapter.checkOrder("777")).toMatchObject({ status: "failed", retryable: false, supplierOrderId: "777" });
    await expect(adapter.checkOrder("404")).rejects.toMatchObject({ retryable: false });
  });
});

describe("batstore getBalance", () => {
  it("reads wallet_balance from /me", async () => {
    const { ctx } = context({ "GET /api/reseller/me": json({ success: true, user_telegram_id: 1, wallet_balance: 0.08 }) }, config);
    expect(await createBatStore(ctx).getBalance()).toEqual({ amountCents: 8, currency: "USD" });
  });

  it("refuses to run without a key", async () => {
    const { ctx, calls } = context({}, {});
    await expect(createBatStore(ctx).getBalance()).rejects.toThrow(/BATSTORE_API_KEY/);
    expect(calls).toHaveLength(0);
  });
});

describe("batstore parseWebhook", () => {
  it("authenticates the shared secret and re-reads the order", async () => {
    const { ctx, calls } = context(
      { [`GET ${ORDERS}/777`]: json({ success: true, order: { id: 777, status: "COMPLETED", items: [{ account_data: "CODE-1" }] } }) },
      { ...config, SUPPLIER_WEBHOOK_SECRET: "shared" },
    );
    const adapter = createBatStore(ctx);
    const req = (secret: string) =>
      new Request("https://store.example/hooks/batstore", { method: "POST", headers: { "X-Supplier-Webhook-Secret": secret }, body: JSON.stringify({ order_id: 777, status: "failed" }) });
    expect(await adapter.parseWebhook!(req("wrong"))).toBeNull();
    expect(calls).toHaveLength(0);
    // The body says "failed"; the supplier's own record wins.
    expect(await adapter.parseWebhook!(req("shared"))).toEqual({
      supplierOrderId: "777",
      result: { status: "delivered", supplierOrderId: "777", items: [{ kind: "account", value: "CODE-1" }] },
    });
  });
});
