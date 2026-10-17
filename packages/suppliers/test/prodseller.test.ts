import { describe, expect, it } from "vitest";
import { createProdSeller } from "../src/prodseller";
import { context, json, networkError } from "./fake-fetch";

const KEY = "psk_test-key";
const config = { PRODSELLER_API_KEY: KEY };
const req = { externalId: "6a316a7b1777fc2347835653", quantity: 1, fields: {}, idempotencyKey: "order-9-line-0" };

describe("prodseller listProducts", () => {
  it("maps Mongo ids, prices and inStock", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/products": json({
          products: [
            { id: "6a316a7b1777fc2347835653", name: "Canva Pro", price: 0.5, inStock: true, publicPrice: 1.0, imageUrl: "https://img.example/c.png" },
            { id: "6a2fda51035a6d898f2106fe", name: "ChatGPT Plus", price: "3.333", inStock: false },
            { id: "6a2fdb4f035a6d898f2106ff", price: 2 },
            { id: "", name: "No id", price: 1 },
          ],
        }),
      },
      config,
    );
    const list = await createProdSeller(ctx).listProducts();
    expect(list.map((p) => [p.externalId, p.name, p.costCents, p.available, p.kind])).toEqual([
      ["6a316a7b1777fc2347835653", "Canva Pro", 50, true, "code"],
      // $3.333 costs 334 cents: a fraction of a cent rounds up.
      ["6a2fda51035a6d898f2106fe", "ChatGPT Plus", 334, false, "code"],
      ["6a2fdb4f035a6d898f2106ff", "ProdSeller 6a2fdb", 200, true, "code"],
    ]);
    expect(list[0]?.meta).toMatchObject({ publicPriceCents: 100, image: "https://img.example/c.png" });
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });
});

describe("prodseller purchase", () => {
  it("delivers deliveredKey and deliveredKeys without duplicates", async () => {
    const { ctx, calls } = context(
      {
        "POST /v1/orders": json({
          orderId: "ps_order_999",
          status: "completed",
          deliveredKey: "KEY-1234-ABCD",
          deliveredKeys: ["KEY-1234-ABCD", "https://www.canva.com/brand/join?token=abc"],
        }),
      },
      config,
    );
    expect(await createProdSeller(ctx).purchase(req)).toEqual({
      status: "delivered",
      supplierOrderId: "ps_order_999",
      items: [{ kind: "code", value: "KEY-1234-ABCD" }, { kind: "link", value: "https://www.canva.com/brand/join?token=abc" }],
    });
    expect(calls[0]?.headers["idempotency-key"]).toBe("order-9-line-0");
    expect(calls[0]?.body).toEqual({ productId: "6a316a7b1777fc2347835653", quantity: 1 });
  });

  it("reports an order without keys as pending", async () => {
    const { ctx } = context({ "POST /v1/orders": json({ id: "ps_1", status: "processing" }) }, config);
    expect(await createProdSeller(ctx).purchase(req)).toEqual({ status: "pending", supplierOrderId: "ps_1" });
  });

  it("caps the idempotency header at 100 characters", async () => {
    const { ctx, calls } = context({ "POST /v1/orders": json({ orderId: "ps_2", status: "pending" }) }, config);
    await createProdSeller(ctx).purchase({ ...req, idempotencyKey: "k".repeat(150) });
    expect(calls[0]?.headers["idempotency-key"]).toHaveLength(100);
  });

  it.each([
    [409, { error: "Conflict" }, false, /out of stock/],
    [402, { error: "Payment required" }, true, /balance too low/],
    [400, { error: "Produit en rupture" }, false, /out of stock/],
    [403, { error: "Forbidden" }, false, /credentials/],
    [503, {}, true, /server error/],
  ])("maps HTTP %i to a failure", async (status, body, retryable, reason) => {
    const { ctx } = context({ "POST /v1/orders": json(body, status) }, config);
    const result = await createProdSeller(ctx).purchase(req);
    expect(result).toMatchObject({ status: "failed", retryable });
    expect(result.status === "failed" && result.reason).toMatch(reason);
  });

  it("treats an { error } body in a 200 as a refusal and a network error as retryable", async () => {
    const refused = context({ "POST /v1/orders": json({ error: "Invalid product" }) }, config);
    expect(await createProdSeller(refused.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: false, reason: "Invalid product" });
    const down = context({ "POST /v1/orders": networkError() }, config);
    expect(await createProdSeller(down.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("prodseller checkOrder", () => {
  it("maps statuses from GET /orders/:id", async () => {
    const { ctx } = context(
      {
        "GET /v1/orders/ps_1": [
          json({ orderId: "ps_1", status: "processing" }),
          json({ orderId: "ps_1", status: "active", deliveredKey: "KEY-9" }),
          json({ orderId: "ps_1", status: "rejected" }),
        ],
      },
      config,
    );
    const adapter = createProdSeller(ctx);
    expect(await adapter.checkOrder("ps_1")).toEqual({ status: "pending", supplierOrderId: "ps_1" });
    expect(await adapter.checkOrder("ps_1")).toEqual({ status: "delivered", supplierOrderId: "ps_1", items: [{ kind: "code", value: "KEY-9" }] });
    expect(await adapter.checkOrder("ps_1")).toMatchObject({ status: "failed", retryable: false });
  });

  it("throws (retryable) when ProdSeller is down", async () => {
    const { ctx } = context({ "GET /v1/orders/ps_1": json({}, 500) }, config);
    await expect(createProdSeller(ctx).checkOrder("ps_1")).rejects.toMatchObject({ retryable: true });
  });
});

describe("prodseller getBalance", () => {
  it("reads /balance", async () => {
    const { ctx } = context({ "GET /v1/balance": json({ balance: 12.5, membership: "gold", username: "shop", telegramId: 1 }) }, config);
    expect(await createProdSeller(ctx).getBalance()).toEqual({ amountCents: 1250, currency: "USD" });
  });
});

describe("prodseller parseWebhook", () => {
  it("needs the secret and re-reads the order", async () => {
    const { ctx, calls } = context(
      { "GET /v1/orders/ps_1": json({ orderId: "ps_1", status: "completed", deliveredKey: "KEY-9" }) },
      { ...config, PRODSELLER_WEBHOOK_SECRET: "ps-hook" },
    );
    const adapter = createProdSeller(ctx);
    const req = (url: string) => new Request(url, { method: "POST", body: JSON.stringify({ id: "ps_1" }) });
    expect(await adapter.parseWebhook!(req("https://store.example/h?secret=nope"))).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await adapter.parseWebhook!(req("https://store.example/h?secret=ps-hook"))).toMatchObject({
      supplierOrderId: "ps_1",
      result: { status: "delivered" },
    });
  });
});
