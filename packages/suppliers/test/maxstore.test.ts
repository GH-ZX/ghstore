import { describe, expect, it } from "vitest";
import { createMaxStore } from "../src/maxstore";
import { context, json, networkError } from "./fake-fetch";

const KEY = "test-key";
const config = { MAXSTORE_API_KEY: KEY };
const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

// Shapes follow docs/providers/maxstore-api.md and the website's permissive schemas.
describe("maxstore listProducts", () => {
  it("names packages without their category and categories without their numbering emoji", async () => {
    const { ctx } = context(
      {
        "GET /api/v2/products": json([
          { id: 204, name: "10 ليرة MTN - 1️⃣ رصيد MTN", price: 0.08, category_id: 7, category_title: "1️⃣ رصيد MTN", available: true },
        ]),
      },
      config,
    );
    const [mtn] = await createMaxStore(ctx).listProducts();
    expect(mtn).toMatchObject({ productKey: "category:7", productName: "رصيد MTN", packageName: "10 ليرة MTN" });
  });

  it("reads a wrapped list, params_meta over params, and availability", async () => {
    const { ctx, calls } = context(
      {
        "GET /api/v2/products": json({
          data: {
            products: [
              {
                id: 12, name: "PUBG 60 UC", price: "0.95", category_id: 3, category_title: "PUBG", available: 1, product_type: "package",
                params: ["معرّف اللاعب"],
                params_meta: [{ key: "player_id", type: "number", label_ar: "معرّف اللاعب", label_en: "Player ID" }, { key: "server", type: "select", label: "Server", options: ["EU", "NA"], required: false }],
              },
              { id: 13, title: "Free Fire 100", price: 1.2, available: "0", params: ["معرّف اللاعب"], qty_values: { min: 1, max: 5 } },
              { id: 14, name: "Steam $5", price: 5.6, available: true, product_type: "voucher", stock: 0, category: { id: 9, name: "Steam" } },
              { id: 15, name: "No price" },
            ],
          },
        }),
      },
      config,
    );
    const list = await createMaxStore(ctx).listProducts();
    expect(list.map((p) => [p.externalId, p.costCents, p.available, p.kind])).toEqual([
      ["12", 95, true, "id"],
      ["13", 120, false, "id"],
      ["14", 560, false, "code"],
    ]);
    expect(list[0]?.fields).toEqual([
      { key: "player_id", labelEn: "Player ID", labelAr: "معرّف اللاعب", required: true },
      {
        key: "server", labelEn: "Server", labelAr: "Server", required: false,
        options: [{ value: "EU", labelEn: "EU", labelAr: "EU" }, { value: "NA", labelEn: "NA", labelAr: "NA" }],
      },
    ]);
    expect(list[0]?.meta).toMatchObject({ categoryId: "3", category: "PUBG", qtyMin: 1, qtyMax: 1, fieldOptions: { server: ["EU", "NA"] } });
    expect(list[1]?.fields).toEqual([{ key: "معرّف اللاعب", labelEn: "معرّف اللاعب", labelAr: "معرّف اللاعب", required: true }]);
    expect(list[1]?.meta).toMatchObject({ qtyMin: 1, qtyMax: 5 });
    expect(list[2]?.meta).toMatchObject({ categoryId: "9", category: "Steam" });
    // One store product per MaxStore category; no category, no grouping.
    expect(list[0]).toMatchObject({ productKey: "category:3", productName: "PUBG", packageName: "PUBG 60 UC" });
    expect(list[1]?.productKey).toBeUndefined();
    expect(list[2]).toMatchObject({ productKey: "category:9", productName: "Steam" });
    expect(calls[0]?.headers["api-token"]).toBe(KEY);
  });
});

describe("maxstore purchase", () => {
  const req = { externalId: "12", quantity: 1, fields: { player_id: "5123" }, idempotencyKey: UUID };

  it("sends order_uuid and params, and reports `wait` as pending on our uuid", async () => {
    const { ctx, calls } = context(
      { "POST /api/v2/order": json({ status: "success", data: { order_id: 8812, status: "wait", price: 0.95, data: { player_id: "5123" } } }) },
      config,
    );
    expect(await createMaxStore(ctx).purchase(req)).toEqual({ status: "pending", supplierOrderId: UUID });
    expect(calls[0]?.body).toEqual({ product_id: 12, qty: 1, order_uuid: UUID, params: { player_id: "5123" } });
  });

  it("derives a stable v4-shaped uuid from a non-uuid key", async () => {
    const { ctx, calls } = context(
      { "POST /api/v2/order": [json({ data: { status: "wait" } }), json({ data: { status: "wait" } })] },
      config,
    );
    const adapter = createMaxStore(ctx);
    const first = await adapter.purchase({ ...req, idempotencyKey: "order-7" });
    const second = await adapter.purchase({ ...req, idempotencyKey: "order-7" });
    const sent = calls.map((c) => (c.body as { order_uuid: string }).order_uuid);
    expect(sent[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sent[0]).toBe(sent[1]);
    expect(first).toEqual({ status: "pending", supplierOrderId: sent[0] });
    expect(second).toEqual(first);
  });

  it("fetches the delivery when the order is accepted at once", async () => {
    const { ctx } = context(
      {
        "POST /api/v2/order": json({ status: "success", data: { order_id: 8813, status: "accept", price: 5.6 } }),
        [`GET /api/v2/check?orders=${UUID}`]: json({ data: [{ order_id: UUID, status: "accept", price: 5.6, delivery: ["STEAM-AAAA-BBBB"] }] }),
      },
      config,
    );
    expect(await createMaxStore(ctx).purchase({ ...req, externalId: "14", fields: {} })).toEqual({
      status: "delivered", supplierOrderId: UUID, items: [{ kind: "code", value: "STEAM-AAAA-BBBB" }], costCents: 560,
    });
  });

  it("delivers a top-up as the account it landed on", async () => {
    const { ctx } = context(
      {
        "POST /api/v2/order": json({ data: { order_id: 1, status: "accept", price: 0.95, data: { player_id: "5123" } } }),
        [`GET /api/v2/check?orders=${UUID}`]: json({ data: [] }),
      },
      config,
    );
    expect(await createMaxStore(ctx).purchase(req)).toEqual({
      status: "delivered", supplierOrderId: UUID, items: [{ kind: "id", value: "5123" }], costCents: 95,
    });
  });

  it.each([
    [400, 100, "Insufficient balance", true, /balance too low/],
    [400, 105, "Quantity unavailable", false, /out of stock/],
    [400, 106, "Missing required field", false, /Missing required field/],
    [403, 123, "IP blocked", false, /API token/],
    [429, 111, "Too many requests", true, /temporarily unavailable/],
    [503, 130, "Maintenance", true, /temporarily unavailable/],
  ])("maps HTTP %i code %i to a failure", async (status, code, message, retryable, reason) => {
    const { ctx } = context({ "POST /api/v2/order": json({ detail: { code, message } }, status) }, config);
    const result = await createMaxStore(ctx).purchase(req);
    expect(result).toMatchObject({ status: "failed", retryable });
    expect(result.status === "failed" && result.reason).toMatch(reason);
  });

  it("maps reject, a detail inside a 200, and a network error", async () => {
    const rejected = context({ "POST /api/v2/order": json({ data: { order_id: 2, status: "reject" } }) }, config);
    expect(await createMaxStore(rejected.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: false, supplierOrderId: UUID });
    const detail = context({ "POST /api/v2/order": json({ detail: { code: 109, message: "Product deleted" } }) }, config);
    expect(await createMaxStore(detail.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: false });
    const down = context({ "POST /api/v2/order": networkError() }, config);
    expect(await createMaxStore(down.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("maxstore checkOrder", () => {
  it("polls /check by order uuid", async () => {
    const { ctx, calls } = context(
      {
        [`GET /api/v2/check?orders=${UUID}`]: [
          json({ data: [] }),
          json({ data: [{ order_id: UUID, status: "wait" }] }),
          json({ data: [{ order_id: UUID, status: "accept", delivery: [{ code: "C-1" }, { code: "https://redeem.example/x" }] }] }),
          json({ data: [{ order_id: UUID, status: "reject" }] }),
        ],
      },
      config,
    );
    const adapter = createMaxStore(ctx);
    expect(await adapter.checkOrder(UUID)).toEqual({ status: "pending", supplierOrderId: UUID });
    expect(await adapter.checkOrder(UUID)).toEqual({ status: "pending", supplierOrderId: UUID });
    expect(await adapter.checkOrder(UUID)).toEqual({
      status: "delivered", supplierOrderId: UUID, items: [{ kind: "code", value: "C-1" }, { kind: "link", value: "https://redeem.example/x" }],
    });
    expect(await adapter.checkOrder(UUID)).toMatchObject({ status: "failed", retryable: false });
    expect(calls[0]?.headers["api-token"]).toBe(KEY);
  });

  it("throws on auth failures so they are never retried blindly", async () => {
    const { ctx } = context({ [`GET /api/v2/check?orders=${UUID}`]: json({ detail: { code: 121, message: "Token error" } }, 401) }, config);
    await expect(createMaxStore(ctx).checkOrder(UUID)).rejects.toMatchObject({ retryable: false });
  });
});

describe("maxstore getBalance", () => {
  it("reads /profile", async () => {
    const { ctx } = context({ "GET /api/v2/profile": json({ balance: "42.10", user_id: 7, username: "shop" }) }, config);
    expect(await createMaxStore(ctx).getBalance()).toEqual({ amountCents: 4210, currency: "USD" });
  });
});
