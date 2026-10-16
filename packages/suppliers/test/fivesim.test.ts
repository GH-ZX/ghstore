import { describe, expect, it } from "vitest";
import { createFiveSim } from "../src/fivesim";
import { context, json, networkError, text } from "./fake-fetch";

const KEY = "test-key";
/** 5sim answers in US dollars today. */
const config = { FIVESIM_API_KEY: KEY };
/** An old ruble account. */
const rub = { ...config, FIVESIM_RUB_USD_RATE: "0.011" };

// Shapes follow the old bot's services/fivesim.py and tests/test_fivesim_service.py.
const usaPrices = {
  usa: {
    telegram: { virtual21: { cost: 45.0, count: 10 }, virtual4: { cost: 40.0, count: 25 }, virtual9: { cost: 10.0, count: 0 } },
    whatsapp: { virtual4: { cost: 30.0, count: 0 } },
  },
};

describe("fivesim listProducts", () => {
  it("prices each country/service at the cheapest operator with numbers, converting rubles up to cents", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/guest/prices?country=usa": json(usaPrices),
        "GET /v1/guest/prices?country=england": json({ england: { telegram: { virtual4: { cost: 20.5, count: 3 } } } }),
      },
      { ...rub, FIVESIM_COUNTRIES: "usa, England" },
    );
    const list = await createFiveSim(ctx).listProducts();
    // 40 RUB * 0.011 = 0.44 USD; 20.5 * 0.011 = 0.2255 → 23 (rounded up).
    expect(list.map((p) => [p.externalId, p.costCents, p.available, p.kind])).toEqual([
      ["usa/telegram", 44, true, "sms"],
      ["usa/whatsapp", 33, false, "sms"],
      ["england/telegram", 23, true, "sms"],
    ]);
    expect(list[0]?.meta).toMatchObject({ country: "usa", service: "telegram", stock: 35, maxCostCents: 50 });
    // One store product per service, a package per country.
    expect(list[0]).toMatchObject({ productKey: "service:telegram", productName: "Telegram number", productNameAr: "رقم Telegram", packageName: "Usa" });
    // Guest prices are public: no key goes out.
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
  });

  it("filters services and applies a configured rate", async () => {
    const { ctx } = context(
      { "GET /v1/guest/prices": json(usaPrices) },
      { ...config, FIVESIM_SERVICES: "telegram", FIVESIM_RUB_USD_RATE: "0.0105" },
    );
    const list = await createFiveSim(ctx).listProducts();
    expect(list.map((p) => [p.externalId, p.costCents])).toEqual([["usa/telegram", 42]]);
  });
});

describe("fivesim catalogue by service", () => {
  const routes = {
    "GET /v1/guest/products/any/any": json({
      whatsapp: { Category: "activation", Qty: 900, Price: 30 },
      telegram: { Category: "activation", Qty: 4000, Price: 40 },
      "3hours": { Category: "hosting", Qty: 10, Price: 100 },
    }),
    "GET /v1/guest/countries": json({
      usa: { iso: { us: 1 }, prefix: { "+1": 1 }, text_en: "USA", text_ru: "США" },
      england: { iso: { gb: 1 }, prefix: { "+44": 1 }, text_en: "England" },
    }),
    "GET /v1/guest/prices?product=telegram": json({
      telegram: {
        usa: { virtual21: { cost: 45.0, count: 10 }, virtual4: { cost: 40.0, count: 25 } },
        england: { virtual4: { cost: 20.5, count: 0 } },
      },
    }),
  };

  it("lists services (activation only, most numbers first), then a service's countries with flags and Arabic names", async () => {
    const { ctx, calls } = context(routes, rub);
    const g = createFiveSim(ctx);
    expect(await g.listGroups!()).toEqual([
      { id: "service:telegram", name: "Telegram" },
      { id: "service:whatsapp", name: "WhatsApp" },
    ]);
    const list = await g.listProducts("service:telegram");
    expect(list.map((p) => [p.externalId, p.costCents, p.available])).toEqual([["usa/telegram", 44, true], ["england/telegram", 23, false]]);
    expect(list[0]).toMatchObject({ productKey: "service:telegram", productName: "Telegram number", packageName: "🇺🇸 USA" });
    expect(list[0]!.packageNameAr).toMatch(/^🇺🇸 /);
    expect(list[1]!.packageName).toBe("🇬🇧 England");
    // Never the multi-megabyte full price list.
    expect(calls.some((c) => c.path === "/v1/guest/prices")).toBe(false);
  });

  it("prices only the services the store sells, one request each, for the sync", async () => {
    const { ctx, calls } = context(routes, rub);
    const g = createFiveSim(ctx);
    const list = await g.listProductsFor!(["usa/telegram", "england/telegram"]);
    expect(list.map((p) => [p.externalId, p.costCents])).toEqual([["usa/telegram", 44], ["england/telegram", 23]]);
    expect(calls.map((c) => c.path)).toEqual(["/v1/guest/prices?product=telegram"]);
    expect(g.syncGroup!("usa/telegram")).toBe("service:telegram");
  });
});

describe("fivesim purchase", () => {
  const req = { externalId: "usa/telegram", quantity: 1, fields: {}, idempotencyKey: "order-5" };

  it("buys a number with operator any and returns it pending", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/user/buy/activation/usa/any/telegram": json({
          id: 998877, phone: "+1234567890", operator: "virtual4", product: "telegram", price: 40.0,
          status: "PENDING", expires: "2026-09-13T12:00:00Z", country: "usa", created_at: "2026-09-13T11:45:00Z",
        }),
      },
      config,
    );
    expect(await createFiveSim(ctx).purchase(req)).toEqual({
      status: "pending",
      supplierOrderId: "998877",
      items: [{ kind: "phone", value: "+1234567890" }],
      expiresAt: "2026-09-13T12:00:00.000Z",
    });
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("caps the price at the package's cost, in rubles", async () => {
    const { ctx, calls } = context(
      { "GET /v1/user/buy/activation/usa/any/telegram": json({ id: 5, phone: "+1555", status: "PENDING" }) },
      rub,
    );
    await createFiveSim(ctx).purchase({ ...req, maxCostCents: 44 });
    // 44 cents / 0.011 = 40 RUB.
    expect(calls.at(-1)?.path).toBe("/v1/user/buy/activation/usa/any/telegram?maxPrice=40.0000");
  });

  const ratedPrices = {
    usa: {
      telegram: {
        cheap: { cost: 0.1, count: 500, rate: 0, rate168: 12.5 },
        good: { cost: 0.18, count: 40, rate168: 73.4 },
        better: { cost: 0.6, count: 3, rate168: 75 },
        empty: { cost: 0.12, count: 0, rate168: 99 },
      },
    },
  };

  it("buys from the operator with the best success rate that fits the package's cost", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/guest/prices?country=usa&product=telegram": json(ratedPrices),
        "GET /v1/user/buy/activation/usa/good/telegram": json({ id: 6, phone: "+1666", status: "PENDING" }),
      },
      config,
    );
    // 73.4% and 75% are close: the cheaper wins; "better" would not fit 20 cents anyway; "empty" has no numbers.
    expect(await createFiveSim(ctx).purchase({ ...req, maxCostCents: 20 })).toMatchObject({ status: "pending", supplierOrderId: "6" });
    expect(calls.map((c) => c.path)).toEqual(["/v1/guest/prices?country=usa&product=telegram", "/v1/user/buy/activation/usa/good/telegram"]);
  });

  it("gives a number back when its operator charged more than the cap, and buys within the cap", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/guest/prices?country=usa&product=telegram": json(ratedPrices),
        "GET /v1/user/buy/activation/usa/good/telegram": json({ id: 8, phone: "+1888", price: 0.35, status: "PENDING" }),
        "GET /v1/user/cancel/8": json({ id: 8, status: "CANCELED" }),
        "GET /v1/user/buy/activation/usa/any/telegram": json({ id: 9, phone: "+1999", price: 0.19, status: "PENDING" }),
      },
      config,
    );
    expect(await createFiveSim(ctx).purchase({ ...req, maxCostCents: 20 })).toMatchObject({ status: "pending", supplierOrderId: "9" });
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/guest/prices?country=usa&product=telegram",
      "/v1/user/buy/activation/usa/good/telegram",
      "/v1/user/cancel/8",
      "/v1/user/buy/activation/usa/any/telegram?maxPrice=0.2000",
    ]);
  });

  it("keeps (and delivers) the dearer number when 5sim does not confirm its cancel", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/guest/prices?country=usa&product=telegram": json(ratedPrices),
        "GET /v1/user/buy/activation/usa/good/telegram": json({ id: 10, phone: "+1101", price: 0.35, status: "PENDING" }),
        "GET /v1/user/cancel/10": text("order has sms", 400),
      },
      config,
    );
    expect(await createFiveSim(ctx).purchase({ ...req, maxCostCents: 20 })).toMatchObject({ status: "pending", supplierOrderId: "10" });
    expect(calls.some((c) => c.path.includes("/any/"))).toBe(false);
  });

  it("falls back to any operator within the cap when the chosen one just ran out", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/guest/prices?country=usa&product=telegram": json(ratedPrices),
        "GET /v1/user/buy/activation/usa/good/telegram": text("no free phones", 400),
        "GET /v1/user/buy/activation/usa/any/telegram": json({ id: 7, phone: "+1777", status: "PENDING" }),
      },
      config,
    );
    expect(await createFiveSim(ctx).purchase({ ...req, maxCostCents: 20 })).toMatchObject({ status: "pending", supplierOrderId: "7" });
    expect(calls.at(-1)?.path).toBe("/v1/user/buy/activation/usa/any/telegram?maxPrice=0.2000");
  });

  it.each([
    [400, "no free phones", false, /out of stock/],
    [200, "no free phones", false, /out of stock/],
    [400, "not enough user balance", true, /balance too low/],
    [401, "", false, /credentials/],
    [400, "bad country", false, /bad country/],
    [502, "", true, /server error/],
  ])("maps HTTP %i %j to a failure", async (status, body, retryable, reason) => {
    const { ctx } = context({ "GET /v1/user/buy/activation/usa/any/telegram": text(body, status) }, config);
    const result = await createFiveSim(ctx).purchase(req);
    expect(result).toMatchObject({ status: "failed", retryable });
    expect(result.status === "failed" && result.reason).toMatch(reason);
  });

  it("treats a network error as retryable and rejects bad input without calling out", async () => {
    const down = context({ "GET /v1/user/buy/activation/usa/any/telegram": networkError() }, config);
    expect(await createFiveSim(down.ctx).purchase(req)).toMatchObject({ status: "failed", retryable: true });
    const { ctx, calls } = context({}, config);
    expect(await createFiveSim(ctx).purchase({ ...req, externalId: "telegram" })).toMatchObject({ status: "failed", retryable: false });
    expect(await createFiveSim(ctx).purchase({ ...req, quantity: 3 })).toMatchObject({ status: "failed", retryable: false });
    expect(calls).toHaveLength(0);
  });
});

describe("fivesim checkOrder", () => {
  it("stays pending until the SMS arrives, then delivers the code and finishes the order", async () => {
    const { ctx, calls } = context(
      {
        "GET /v1/user/check/998877": [
          json({ id: 998877, phone: "+1234567890", status: "PENDING", sms: [] }),
          json({
            id: 998877, phone: "+1234567890", status: "RECEIVED",
            sms: [{ created_at: "2026-09-13T11:47:00Z", sender: "Telegram", text: "Your login code is 849201", code: "849201" }],
          }),
        ],
        "GET /v1/user/finish/998877": json({ id: 998877, status: "FINISHED" }),
      },
      config,
    );
    const adapter = createFiveSim(ctx);
    expect(await adapter.checkOrder("998877")).toEqual({
      status: "pending", supplierOrderId: "998877", items: [{ kind: "phone", value: "+1234567890" }],
    });
    expect(await adapter.checkOrder("998877")).toEqual({
      status: "delivered",
      supplierOrderId: "998877",
      items: [{ kind: "phone", value: "+1234567890" }, { kind: "sms", value: "849201", label: "Your login code is 849201" }],
    });
    expect(calls.map((c) => c.path)).toEqual(["/v1/user/check/998877", "/v1/user/check/998877", "/v1/user/finish/998877"]);
  });

  it.each(["TIMEOUT", "CANCELED", "BANNED"])("fails a %s order without an SMS", async (status) => {
    const { ctx } = context({ "GET /v1/user/check/1": json({ id: 1, phone: "+1", status, sms: null }) }, config);
    expect(await createFiveSim(ctx).checkOrder("1")).toMatchObject({ status: "failed", retryable: false, supplierOrderId: "1" });
  });

  it("throws (retryable) when 5sim is unreachable", async () => {
    const { ctx } = context({ "GET /v1/user/check/1": networkError() }, config);
    await expect(createFiveSim(ctx).checkOrder("1")).rejects.toMatchObject({ retryable: true });
  });
});

describe("fivesim cancel and ban", () => {
  it("returns true when 5sim accepts and false when it refuses", async () => {
    const { ctx } = context(
      {
        "GET /v1/user/cancel/1": json({ id: 1, status: "CANCELED" }),
        "GET /v1/user/cancel/2": text("order has sms", 400),
        "GET /v1/user/ban/3": json({ id: 3, status: "BANNED" }),
      },
      config,
    );
    const adapter = createFiveSim(ctx);
    expect(await adapter.cancel!("1")).toBe(true);
    expect(await adapter.cancel!("2")).toBe(false);
    expect(await adapter.ban("3")).toBe(true);
  });

  it("throws when the outcome is unknown", async () => {
    const { ctx } = context({ "GET /v1/user/cancel/1": json({}, 503) }, config);
    await expect(createFiveSim(ctx).cancel!("1")).rejects.toMatchObject({ retryable: true });
  });
});

describe("fivesim success rates", () => {
  it("prices a country from its best operator and shows that operator's success rate", async () => {
    const { ctx } = context(
      {
        "GET /v1/guest/countries": json({ usa: { iso: { us: 1 }, text_en: "USA" } }),
        "GET /v1/guest/prices?product=telegram": json({
          telegram: {
            usa: {
              cheap: { cost: 0.1, count: 500, rate168: 12.5 },
              good: { cost: 0.18, count: 40, rate168: 73.4, rate720: 60 },
            },
          },
        }),
      },
      config,
    );
    const [usa] = await createFiveSim(ctx).listProducts("service:telegram");
    expect(usa).toMatchObject({ externalId: "usa/telegram", costCents: 18, successPct: 73.4, available: true });
    expect(usa!.meta).toMatchObject({ operator: "good" });
  });
});

describe("fivesim account", () => {
  it("shows the profile, the dollar balance and the latest numbers, never the key", async () => {
    const { ctx } = context(
      {
        "GET /v1/user/profile": json({ id: 1234, email: "me@example.com", balance: 0.3, rating: 96, default_country: { name: "any" }, api_key: "x" }),
        "GET /v1/user/orders?category=activation&limit=15&offset=0&order=id&reverse=true": json({
          Data: [{ id: 9, phone: "+31600", operator: "virtual58", product: "telegram", price: 0.1, status: "BANNED", created_at: "2026-10-16T10:00:00Z", country: "netherlands" }],
        }),
      },
      config,
    );
    const info = await createFiveSim(ctx).accountInfo!();
    expect(info.balances).toEqual([{ currency: "USD", amount: 0.3 }]);
    expect(info.fields.map((f) => f.label)).toEqual(["Id", "Email", "Rating", "Default country name"]);
    expect(info.history[0]).toMatchObject({ amount: -0.1, currency: "USD", text: "Telegram · netherlands · banned" });
  });
});

describe("fivesim getBalance", () => {
  it("reads a dollar balance as it is", async () => {
    const { ctx } = context({ "GET /v1/user/profile": json({ id: 1, balance: 0.3 }) }, config);
    expect(await createFiveSim(ctx).getBalance()).toEqual({ amountCents: 30, currency: "USD" });
  });

  it("converts a ruble balance down to whole cents", async () => {
    const { ctx } = context({ "GET /v1/user/profile": json({ id: 1234, email: "test@example.com", balance: 150.5, rating: 98 }) }, rub);
    // 150.5 RUB * 0.011 = 1.6555 USD → 165 cents (rounded down).
    expect(await createFiveSim(ctx).getBalance()).toEqual({ amountCents: 165, currency: "USD" });
  });

  it("does not retry an invalid key", async () => {
    const { ctx } = context({ "GET /v1/user/profile": text("Unauthorized", 401) }, config);
    await expect(createFiveSim(ctx).getBalance()).rejects.toMatchObject({ retryable: false });
  });
});
