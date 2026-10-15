import { describe, expect, it } from "vitest";
import { createG2Bulk } from "../src/g2bulk";
import { context, json, networkError, type Recorded } from "./fake-fetch";

const API = "https://api.g2bulk.com/v1";
const KEY = "test-key";
const UUID = "550e8400-e29b-41d4-a716-446655440000";
const config = { G2BULK_API_KEY: KEY, G2BULK_WEBHOOK_SECRET: "hook-secret" };

// Shapes below follow docs/providers/g2bulk-api.md from the old website repo.
const fields = (req: Recorded) => {
  const game = (req.body as { game: string }).game;
  return json({ code: "200", info: { fields: game === "mlbb" ? ["userid", "zoneid"] : ["userid"], notes: "" } })(req);
};

const catalogueRoutes = {
  "GET /v1/games": json({
    success: true,
    games: [
      { id: 1, code: "pubgm", name: "PUBG Mobile", image_url: "/images/pubgm.png" },
      { id: 2, code: "mlbb", name: "Mobile Legends", image_url: "https://cdn.example/mlbb.png" },
    ],
  }),
  "GET /v1/games/pubgm/catalogue": json({
    success: true,
    game: { code: "pubgm", name: "PUBG Mobile" },
    catalogues: [
      { id: 1, name: "60 UC", amount: 0.88 },
      { id: 2, name: "120 UC", amount: 1.75 },
    ],
  }),
  "GET /v1/games/mlbb/catalogue": json({ success: true, catalogues: [{ id: 9, name: "86 Diamonds", amount: 1.126 }] }),
  "POST /v1/games/fields": fields,
  "POST /v1/games/servers": json({ code: "200", servers: { "SouthEast Asia": "sea", Europe: "eu" } }),
  "GET /v1/products": json({
    success: true,
    products: [
      { id: 1, title: "60 UC Voucher", category_id: 1, category_title: "PUBG Mobile UC Vouchers", unit_price: 0.84, face_value: 1, stock: 1006 },
      { id: 2, title: "PSN $20 Gift Card", category_id: 4, unit_price: "18.105", stock: 0 },
      { id: 3, title: "Broken price", unit_price: null, stock: 5 },
    ],
  }),
};

describe("g2bulk listProducts", () => {
  it("maps top-up denominations and vouchers to cents with input fields", async () => {
    const { ctx, calls } = context(catalogueRoutes, config);
    const products = await createG2Bulk(ctx).listProducts();

    expect(products.map((p) => [p.externalId, p.costCents, p.available, p.kind])).toEqual([
      ["game:pubgm:60 UC", 88, true, "id"],
      ["game:pubgm:120 UC", 175, true, "id"],
      ["game:mlbb:86 Diamonds", 113, true, "id"],
      ["voucher:1", 84, true, "code"],
      ["voucher:2", 1811, false, "code"],
    ]);
    const pubg = products[0]!;
    expect(pubg.name).toBe("PUBG Mobile — 60 UC");
    expect(pubg.fields).toEqual([{ key: "player_id", labelEn: "Player ID", labelAr: "معرّف اللاعب (ID)", required: true }]);
    expect(pubg.meta?.image).toBe("https://api.g2bulk.com/images/pubgm.png");
    const mlbb = products[2]!;
    expect(mlbb.fields?.map((f) => f.key)).toEqual(["player_id", "server_id"]);
    expect(mlbb.meta?.servers).toEqual({ "SouthEast Asia": "sea", Europe: "eu" });
    expect(mlbb.meta?.image).toBe("https://cdn.example/mlbb.png");
    // Servers are only asked for games whose fields need one; public routes carry no key.
    expect(calls.filter((c) => c.path === "/v1/games/servers").map((c) => c.body)).toEqual([{ game: "mlbb" }]);
    expect(calls.every((c) => c.headers["x-api-key"] === undefined)).toBe(true);
  });

  it("honours G2BULK_GAME_CODES", async () => {
    const { ctx, calls } = context(catalogueRoutes, { ...config, G2BULK_GAME_CODES: "MLBB" });
    const products = await createG2Bulk(ctx).listProducts();
    expect(products.filter((p) => p.kind === "id").map((p) => p.externalId)).toEqual(["game:mlbb:86 Diamonds"]);
    expect(calls.some((c) => c.path.includes("pubgm"))).toBe(false);
  });

  it("fails the whole sync (retryable) rather than return a partial catalogue", async () => {
    const { ctx } = context(
      { ...catalogueRoutes, "GET /v1/games/pubgm/catalogue": [json({}, 502), json({}, 503)] },
      config,
    );
    await expect(createG2Bulk(ctx).listProducts()).rejects.toMatchObject({ name: "AdapterError", retryable: true });
  });
});

describe("g2bulk purchase", () => {
  const topUp = { externalId: "game:mlbb:86 Diamonds", quantity: 1, fields: { player_id: "123456", server_id: "2001" }, idempotencyKey: UUID };

  it("places a top-up after validating the player and reports it pending", async () => {
    const { ctx, calls } = context(
      {
        "POST /v1/games/checkPlayerId": json({ valid: "valid", name: "John Doe", openid: "4158" }),
        "POST /v1/games/mlbb/order": json({
          success: true,
          message: "Order created successfully.",
          order: { order_id: 42, game: "Mobile Legends", catalogue: "86 Diamonds", player_id: "123456", player_name: "John Doe", price: 1.126, status: "PENDING" },
        }),
      },
      { ...config, G2BULK_CALLBACK_URL: "https://store.example/hooks/g2bulk" },
    );
    const result = await createG2Bulk(ctx).purchase(topUp);

    expect(result).toEqual({ status: "pending", supplierOrderId: "g2b-game-42" });
    expect(calls[0]?.body).toEqual({ game: "mlbb", user_id: "123456", server_id: "2001" });
    const order = calls[1]!;
    expect(order.headers["x-api-key"]).toBe(KEY);
    expect(order.headers["x-idempotency-key"]).toBe(UUID);
    expect(order.body).toEqual({
      catalogue_name: "86 Diamonds",
      player_id: "123456",
      server_id: "2001",
      remark: UUID,
      callback_url: "https://store.example/hooks/g2bulk?token=hook-secret",
    });
  });

  it("returns delivered with the player id and supplier cost when the top-up completes at once", async () => {
    const { ctx } = context(
      {
        "POST /v1/games/checkPlayerId": json({ valid: "valid", name: "John Doe" }),
        "POST /v1/games/mlbb/order": json({ success: true, order: { order_id: 43, player_name: "John Doe", price: 0.88, status: "COMPLETED" } }),
      },
      config,
    );
    expect(await createG2Bulk(ctx).purchase(topUp)).toEqual({
      status: "delivered",
      supplierOrderId: "g2b-game-43",
      items: [{ kind: "id", value: "123456", label: "John Doe" }],
      costCents: 88,
    });
  });

  it("maps a non-UUID idempotency key with uuid5(NAMESPACE_DNS) like the old bot", async () => {
    const { ctx, calls } = context(
      {
        "POST /v1/games/checkPlayerId": json({}, 500),
        "POST /v1/games/mlbb/order": json({ success: true, order: { order_id: 44, status: "PENDING" } }),
      },
      config,
    );
    await createG2Bulk(ctx).purchase({ ...topUp, idempotencyKey: "python.org" });
    // Python: str(uuid.uuid5(uuid.NAMESPACE_DNS, "python.org"))
    expect(calls[1]?.headers["x-idempotency-key"]).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("refuses an invalid player before charging", async () => {
    const { ctx, calls } = context({ "POST /v1/games/checkPlayerId": json({ valid: "invalid" }) }, config);
    const result = await createG2Bulk(ctx).purchase(topUp);
    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(calls.map((c) => c.path)).toEqual(["/v1/games/checkPlayerId"]);
  });

  it("requires a player id and quantity 1 for top-ups", async () => {
    const { ctx, calls } = context({}, config);
    const adapter = createG2Bulk(ctx);
    expect(await adapter.purchase({ ...topUp, fields: {} })).toMatchObject({ status: "failed", retryable: false });
    expect(await adapter.purchase({ ...topUp, quantity: 2 })).toMatchObject({ status: "failed", retryable: false });
    expect(calls).toHaveLength(0);
  });

  const voucher = { externalId: "voucher:1", quantity: 2, fields: {}, idempotencyKey: UUID };

  it("delivers voucher codes returned at once", async () => {
    const { ctx, calls } = context(
      {
        "POST /v1/products/1/purchase": json({
          success: true, order_id: 123, transaction_id: 456, product_id: 1, product_title: "60 UC Voucher",
          status: "COMPLETED", delivery_items: ["KEY1", { code: "KEY2" }],
        }),
      },
      config,
    );
    expect(await createG2Bulk(ctx).purchase(voucher)).toEqual({
      status: "delivered",
      supplierOrderId: "g2b-vouch-123",
      items: [{ kind: "code", value: "KEY1" }, { kind: "code", value: "KEY2" }],
    });
    expect(calls[0]?.body).toEqual({ quantity: 2 });
    expect(calls[0]?.headers["x-idempotency-key"]).toBe(UUID);
  });

  it("reports a pending voucher", async () => {
    const { ctx } = context(
      { "POST /v1/products/1/purchase": json({ success: true, order_id: 124, status: "PENDING", delivery_items: null, poll_url: "/v1/orders/124/delivery" }) },
      config,
    );
    expect(await createG2Bulk(ctx).purchase(voucher)).toEqual({ status: "pending", supplierOrderId: "g2b-vouch-124" });
  });

  it.each([
    [409, { success: false, message: "Product out of stock" }, false, /out of stock/],
    [400, { success: false, message: "Insufficient balance" }, true, /balance too low/],
    [401, { success: false, message: "Invalid API key" }, false, /credentials/],
    [429, { success: false, message: "Too many requests" }, true, /rate limit/],
    [500, { success: false, message: "boom" }, true, /server error/],
    [400, { success: false, message: "Invalid quantity" }, false, /Invalid quantity/],
  ])("maps HTTP %i to a failure", async (status, body, retryable, reason) => {
    const { ctx } = context({ "POST /v1/products/1/purchase": json(body, status) }, config);
    const result = await createG2Bulk(ctx).purchase(voucher);
    expect(result).toMatchObject({ status: "failed", retryable });
    expect(result.status === "failed" && result.reason).toMatch(reason);
  });

  it("treats a network error as retryable and never leaks the key", async () => {
    const { ctx } = context({ "POST /v1/products/1/purchase": networkError() }, config);
    const result = await createG2Bulk(ctx).purchase(voucher);
    expect(result).toMatchObject({ status: "failed", retryable: true });

    const echo = context({ "POST /v1/products/1/purchase": json({ success: false, message: `bad key ${KEY}` }, 400) }, config);
    const leaked = await createG2Bulk(echo.ctx).purchase(voucher);
    expect(JSON.stringify(leaked)).not.toContain(KEY);
  });

  it("rejects unknown product ids and a missing key without calling out", async () => {
    const { ctx, calls } = context({}, {});
    expect(await createG2Bulk(ctx).purchase({ ...voucher, externalId: "nope" })).toMatchObject({ status: "failed", retryable: false });
    expect(await createG2Bulk(ctx).purchase(voucher)).toMatchObject({ status: "failed", retryable: false });
    expect(calls).toHaveLength(0);
  });
});

describe("g2bulk checkOrder", () => {
  it("reads voucher delivery by status code", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/orders/124/delivery": [
          json({ success: true, order_id: 124, status: "PROCESSING" }, 202),
          json({ success: true, order_id: 124, status: "COMPLETED", delivery_items: ["XXXX-XXXX-XXXX"] }),
          json({ success: false, status: "REFUNDED", refunded: true }, 410),
        ],
      },
      config,
    );
    const adapter = createG2Bulk(ctx);
    expect(await adapter.checkOrder("g2b-vouch-124")).toEqual({ status: "pending", supplierOrderId: "g2b-vouch-124" });
    expect(await adapter.checkOrder("g2b-vouch-124")).toEqual({
      status: "delivered", supplierOrderId: "g2b-vouch-124", items: [{ kind: "code", value: "XXXX-XXXX-XXXX" }],
    });
    expect(await adapter.checkOrder("g2b-vouch-124")).toMatchObject({ status: "failed", retryable: false });
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("walks the paginated top-up history to find the order", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/games/orders?page=1&limit=100": json({
          success: true,
          orders: [{ order_id: 41, status: "completed", is_refunded: false }],
          pagination: { page: 1, limit: 100, total: 2, total_pages: 2 },
        }),
        "GET /v1/games/orders?page=2&limit=100": json({
          success: true,
          orders: [{ order_id: 42, player_id: "123456", player_name: "PlayerOne", price: 0.84, status: "completed", is_refunded: false }],
          pagination: { page: 2, limit: 100, total: 2, total_pages: 2 },
        }),
      },
      config,
    );
    expect(await createG2Bulk(ctx).checkOrder("g2b-game-42")).toEqual({
      status: "delivered",
      supplierOrderId: "g2b-game-42",
      items: [{ kind: "id", value: "123456", label: "PlayerOne" }],
      costCents: 84,
    });
    expect(calls).toHaveLength(2);
  });

  it("treats a refunded or failed top-up as failed and a missing one as pending", async () => {
    const { ctx } = context(
      {
        "GET /v1/games/orders?page=1&limit=100": [
          json({ success: true, orders: [{ order_id: 42, status: "completed", is_refunded: true }] }),
          json({ success: true, orders: [] }),
        ],
      },
      config,
    );
    const adapter = createG2Bulk(ctx);
    expect(await adapter.checkOrder("g2b-game-42")).toMatchObject({ status: "failed", retryable: false });
    expect(await adapter.checkOrder("g2b-game-42")).toEqual({ status: "pending", supplierOrderId: "g2b-game-42" });
  });

  it("throws on ids it does not recognise", async () => {
    const { ctx } = context({}, config);
    await expect(createG2Bulk(ctx).checkOrder("42")).rejects.toThrow(/unrecognised/);
  });
});

describe("g2bulk getBalance", () => {
  it("reads /getMe with the key", async () => {
    const { ctx, calls } = context(
      { "GET /v1/getMe": json({ success: true, user_id: 123456789, username: "johndoe", first_name: "John Doe", balance: 8.74 }) },
      config,
    );
    expect(await createG2Bulk(ctx).getBalance()).toEqual({ amountCents: 874, currency: "USD" });
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("does not retry a rejected key", async () => {
    const { ctx } = context({ "GET /v1/getMe": json({ success: false, message: "Unauthorized" }, 401) }, config);
    await expect(createG2Bulk(ctx).getBalance()).rejects.toMatchObject({ retryable: false });
  });
});

describe("g2bulk parseWebhook", () => {
  const callback = { order_id: 42, game_code: "mlbb", player_id: "123456", status: "COMPLETED", remark: UUID };
  const completedList = json({ success: true, orders: [{ order_id: 42, player_id: "123456", status: "completed", price: 0.88 }] });
  const post = (url: string, body: unknown = callback, headers: Record<string, string> = {}) =>
    new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  it("accepts the token, then re-reads the order instead of trusting the body", async () => {
    const { ctx, calls } = context({ "GET /v1/games/orders?page=1&limit=100": completedList }, config);
    const parsed = await createG2Bulk(ctx).parseWebhook!(post("https://store.example/hooks/g2bulk?token=hook-secret"));
    expect(parsed).toEqual({
      supplierOrderId: "g2b-game-42",
      result: { status: "delivered", supplierOrderId: "g2b-game-42", items: [{ kind: "id", value: "123456" }], costCents: 88 },
    });
    expect(calls).toHaveLength(1);
  });

  it("also accepts the old bot's secret header", async () => {
    const { ctx } = context({ "GET /v1/games/orders?page=1&limit=100": completedList }, { G2BULK_API_KEY: KEY, SUPPLIER_WEBHOOK_SECRET: "shared" });
    const parsed = await createG2Bulk(ctx).parseWebhook!(post("https://store.example/hooks/g2bulk", callback, { "X-Webhook-Secret": "shared" }));
    expect(parsed?.supplierOrderId).toBe("g2b-game-42");
  });

  it("rejects a wrong or missing token, a missing secret, or a GET, without calling G2Bulk", async () => {
    const { ctx, calls } = context({}, config);
    const adapter = createG2Bulk(ctx);
    expect(await adapter.parseWebhook!(post("https://store.example/hooks/g2bulk?token=hook-secreT"))).toBeNull();
    expect(await adapter.parseWebhook!(post("https://store.example/hooks/g2bulk"))).toBeNull();
    expect(await adapter.parseWebhook!(new Request("https://store.example/hooks/g2bulk?token=hook-secret"))).toBeNull();
    const unconfigured = createG2Bulk(context({}, { G2BULK_API_KEY: KEY }).ctx);
    expect(await unconfigured.parseWebhook!(post("https://store.example/hooks/g2bulk?token="))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("ignores an authentic payload without an order id", async () => {
    const { ctx } = context({}, config);
    expect(await createG2Bulk(ctx).parseWebhook!(post("https://store.example/h?token=hook-secret", { status: "COMPLETED" }))).toBeNull();
  });
});
