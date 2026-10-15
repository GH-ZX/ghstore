import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../../core/src/adapters";
import { createNowPayments, mapNowPaymentsStatus, nowPaymentsToEvent } from "../src/nowpayments";
import { context, fakeFetch, type Handler, type Reply } from "./fake-fetch";

const IPN_SECRET = "test-ipn-secret-not-real";
const CONFIG = { NOWPAYMENTS_API_KEY: "test-np-key", NOWPAYMENTS_IPN_SECRET: IPN_SECRET };
const PAYMENT_ID = "8d7f2c1e-0000-4000-8000-000000000002";

function np(config: Record<string, string | undefined>, routes: Array<[string | RegExp, Handler | Reply]>) {
  const fake = fakeFetch(routes);
  return { adapter: createNowPayments(context(fake.fetch, { ...CONFIG, ...config })), calls: fake.calls };
}

/** The docs' Python sample: json.dumps(msg, separators=(",", ":"), sort_keys=True), written independently. */
function pythonCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${pythonCanonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The docs' Node.js sample's sortObject(), arrays and all. */
function nodeSampleSortObject(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const v = obj[key];
      result[key] = v && typeof v === "object" ? nodeSampleSortObject(v as Record<string, unknown>) : v;
      return result;
    }, {});
}

const sign = (message: string, secret = IPN_SECRET) => createHmac("sha512", secret).update(message).digest("hex");

// Modeled on the IPN / GET /payment/{id} body in the NOWPayments docs.
const IPN = {
  payment_id: 5745459419,
  invoice_id: null,
  payment_status: "finished",
  pay_address: "0x1111111111111111111111111111111111111111",
  payin_extra_id: null,
  price_amount: 12.34,
  price_currency: "usd",
  pay_amount: 12.4012,
  actually_paid: 12.4012,
  pay_currency: "usdtbsc",
  order_id: PAYMENT_ID,
  order_description: "Order",
  purchase_id: 5837122679,
  outcome_amount: 12.31,
  outcome_currency: "usdtbsc",
  fee: { currency: "usdtbsc", depositFee: 0, withdrawalFee: 0.05, serviceFee: 0.06 },
};

function ipnRequest(body: unknown, signature: string | null, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-nowpayments-sig"] = signature;
  return new Request("https://store.example/api/payments/nowpayments/ipn", {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  });
}

describe("nowpayments: createPayment", () => {
  it("creates a USDT-BEP20 payment and returns the address to pay", async () => {
    const { adapter, calls } = np({}, [
      [
        "/v1/payment",
        {
          status: 201,
          json: {
            payment_id: "5745459419",
            payment_status: "waiting",
            pay_address: "0xAbC0000000000000000000000000000000000001",
            price_amount: 12.34,
            price_currency: "usd",
            pay_amount: 12.4012,
            pay_currency: "usdtbsc",
            order_id: PAYMENT_ID,
            payin_extra_id: null,
            network: "bsc",
            expiration_estimate_date: "2026-10-15T13:00:00.000Z",
          },
        },
      ],
    ]);
    const created = await adapter.createPayment({
      paymentId: PAYMENT_ID,
      amountCents: 1234,
      description: "Order 42",
      callbackUrl: "https://store.example/ipn",
    });
    expect(created).toEqual({
      providerRef: "5745459419",
      action: {
        type: "address",
        network: "BSC (BEP20)",
        asset: "USDT",
        address: "0xAbC0000000000000000000000000000000000001",
        amount: "12.4012",
      },
      expiresAt: "2026-10-15T13:00:00.000Z",
    });
    const call = calls[0];
    expect(call?.url).toBe("https://api.nowpayments.io/v1/payment");
    expect(call?.method).toBe("POST");
    expect(call?.headers["x-api-key"]).toBe("test-np-key");
    expect(call?.body).toEqual({
      price_amount: 12.34,
      price_currency: "usd",
      pay_currency: "usdtbsc",
      order_id: PAYMENT_ID,
      order_description: "Order 42",
      ipn_callback_url: "https://store.example/ipn",
    });
  });

  it("honours a configured pay currency and optional flags", async () => {
    const { adapter, calls } = np(
      {
        NOWPAYMENTS_PAY_CURRENCY: "USDTTRC20",
        NOWPAYMENTS_FIXED_RATE: "true",
        NOWPAYMENTS_FEE_PAID_BY_USER: "true",
        NOWPAYMENTS_IPN_URL: "https://store.example/ipn2",
        NOWPAYMENTS_BASE_URL: "https://api-sandbox.nowpayments.io/v1/",
      },
      [
        [
          "/v1/payment",
          { json: { payment_id: 1, pay_address: "TXYZ", pay_amount: 5, pay_currency: "usdttrc20", payin_extra_id: "77" } },
        ],
      ],
    );
    const created = await adapter.createPayment({ paymentId: PAYMENT_ID, amountCents: 500, description: "x" });
    expect(created.action).toEqual({ type: "address", network: "TRON (TRC20)", asset: "USDT", address: "TXYZ", amount: "5", memo: "77" });
    expect(calls[0]?.url).toBe("https://api-sandbox.nowpayments.io/v1/payment");
    expect(calls[0]?.body).toMatchObject({
      pay_currency: "usdttrc20",
      is_fixed_rate: true,
      is_fee_paid_by_user: true,
      ipn_callback_url: "https://store.example/ipn2",
    });
  });

  it("refuses a payment opened in a different coin, and reports API errors", async () => {
    const wrong = np({}, [["/v1/payment", { json: { payment_id: 1, pay_address: "bc1q", pay_amount: 0.0002, pay_currency: "btc" } }]]);
    await expect(
      wrong.adapter.createPayment({ paymentId: PAYMENT_ID, amountCents: 100, description: "x", callbackUrl: "https://s/i" }),
    ).rejects.toThrow("expected usdtbsc");

    const bad = np({}, [
      ["/v1/payment", { status: 400, json: { status: false, statusCode: 400, code: "AMOUNT_MINIMAL_ERROR", message: "amountTo is too small" } }],
    ]);
    const error = await bad.adapter
      .createPayment({ paymentId: PAYMENT_ID, amountCents: 1, description: "x", callbackUrl: "https://s/i" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as Error).message).toContain("AMOUNT_MINIMAL_ERROR");
    expect((error as AdapterError).retryable).toBe(false);
  });
});

describe("nowpayments: verifyWebhook", () => {
  it("accepts a correctly signed IPN (HMAC-SHA512 over the key-sorted JSON)", async () => {
    const { adapter, calls } = np({}, []);
    const event = await adapter.verifyWebhook(ipnRequest(IPN, sign(pythonCanonical(IPN))));
    expect(event).toEqual({ providerRef: "5745459419", paymentId: PAYMENT_ID, status: "paid", amountCents: 1234 });
    expect(calls.length).toBe(0);
  });

  it("accepts an uppercase hex signature and a body serialized with whitespace in any key order", async () => {
    const { adapter } = np({}, []);
    const shuffled = Object.fromEntries(Object.entries(IPN).reverse());
    const raw = JSON.stringify(shuffled, null, 2);
    const event = await adapter.verifyWebhook(ipnRequest(null, sign(pythonCanonical(IPN)).toUpperCase(), raw));
    expect(event?.status).toBe("paid");
  });

  it("accepts the docs' Node-sample form for payloads that contain arrays", async () => {
    const { adapter } = np({}, []);
    const body = { ...IPN, payment_extra_ids: [5513339153] };
    expect(await adapter.verifyWebhook(ipnRequest(body, sign(pythonCanonical(body))))).not.toBeNull();
    expect(await adapter.verifyWebhook(ipnRequest(body, sign(JSON.stringify(nodeSampleSortObject(body)))))).not.toBeNull();
  });

  it("rejects a tampered body, a wrong secret, a missing or malformed signature", async () => {
    const { adapter } = np({}, []);
    const good = sign(pythonCanonical(IPN));
    const tampered = { ...IPN, actually_paid: 999, price_amount: 999 };
    expect(await adapter.verifyWebhook(ipnRequest(tampered, good))).toBeNull();
    expect(await adapter.verifyWebhook(ipnRequest(IPN, sign(pythonCanonical(IPN), "other-secret")))).toBeNull();
    expect(await adapter.verifyWebhook(ipnRequest(IPN, null))).toBeNull();
    expect(await adapter.verifyWebhook(ipnRequest(IPN, "abc"))).toBeNull();
    expect(await adapter.verifyWebhook(ipnRequest(IPN, good.slice(0, -2) + "00"))).toBeNull();
    expect(await adapter.verifyWebhook(ipnRequest(null, good, "{not json"))).toBeNull();
    expect(
      await adapter.verifyWebhook(new Request("https://store.example/ipn", { method: "GET", headers: { "x-nowpayments-sig": good } })),
    ).toBeNull();
  });

  it("throws when the IPN secret is not configured", async () => {
    const { adapter } = np({ NOWPAYMENTS_IPN_SECRET: undefined }, []);
    await expect(adapter.verifyWebhook(ipnRequest(IPN, sign(pythonCanonical(IPN))))).rejects.toThrow("NOWPAYMENTS_IPN_SECRET");
  });

  it("never reports a payment in another coin as paid", async () => {
    const { adapter } = np({}, []);
    const btc = { ...IPN, pay_currency: "btc", pay_amount: 0.0002, actually_paid: 0.0002 };
    const event = await adapter.verifyWebhook(ipnRequest(btc, sign(pythonCanonical(btc))));
    expect(event).toEqual({ providerRef: "5745459419", paymentId: PAYMENT_ID, status: "partial" });
  });
});

describe("nowpayments: status mapping", () => {
  const table: Array<[string, string]> = [
    ["waiting", "pending"],
    ["confirming", "pending"],
    ["confirmed", "pending"],
    ["sending", "pending"],
    ["partially_paid", "partial"],
    ["finished", "paid"],
    ["failed", "failed"],
    ["refunded", "failed"],
    ["expired", "expired"],
    ["something_new", "pending"],
  ];
  for (const [theirs, ours] of table) {
    it(`${theirs} -> ${ours}`, () => {
      expect(mapNowPaymentsStatus(theirs)).toBe(ours);
    });
  }

  it("treats confirmed/sending as paid only when configured", () => {
    expect(mapNowPaymentsStatus("confirmed", true)).toBe("paid");
    expect(mapNowPaymentsStatus("sending", true)).toBe("paid");
    expect(mapNowPaymentsStatus("waiting", true)).toBe("pending");
  });

  it("sizes a partial payment in proportion to what arrived, rounding down", () => {
    const event = nowPaymentsToEvent(
      { ...IPN, payment_status: "partially_paid", price_amount: 10, pay_amount: 10.05, actually_paid: 5.025 },
      { payCurrency: "usdtbsc" },
    );
    expect(event).toEqual({ providerRef: "5745459419", paymentId: PAYMENT_ID, status: "partial", amountCents: 500 });
    const dust = nowPaymentsToEvent(
      { ...IPN, payment_status: "partially_paid", price_amount: 10, pay_amount: 10.05, actually_paid: 0.003 },
      { payCurrency: "usdtbsc" },
    );
    expect(dust?.amountCents).toBe(0);
  });

  it("omits the amount while nothing has arrived", () => {
    const event = nowPaymentsToEvent({ ...IPN, payment_status: "waiting", actually_paid: 0 }, { payCurrency: "usdtbsc" });
    expect(event).toEqual({ providerRef: "5745459419", paymentId: PAYMENT_ID, status: "pending" });
  });
});

describe("nowpayments: checkPayment", () => {
  it("asks GET /payment/{id} with the API key", async () => {
    const { adapter, calls } = np({}, [["/v1/payment/5745459419", { json: { ...IPN, payment_status: "confirming" } }]]);
    expect(await adapter.checkPayment("5745459419")).toEqual({ providerRef: "5745459419", paymentId: PAYMENT_ID, status: "pending", amountCents: 1234 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["x-api-key"]).toBe("test-np-key");
  });

  it("refuses a non-numeric id and an answer about another payment", async () => {
    const { adapter, calls } = np({}, [["/v1/payment/1", { json: { ...IPN } }]]);
    await expect(adapter.checkPayment("../invoice")).rejects.toThrow("numeric");
    await expect(adapter.checkPayment("1")).rejects.toThrow("different payment");
    expect(calls.length).toBe(1);
  });
});
