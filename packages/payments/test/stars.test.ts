import { describe, expect, it } from "vitest";
import { AdapterError } from "../../core/src/adapters";
import {
  answerPreCheckout,
  centsForStars,
  createStars,
  parsePreCheckoutQuery,
  parseSuccessfulPayment,
  starsForCents,
} from "../src/stars";
import { context, fakeFetch, type Reply } from "./fake-fetch";

const TOKEN = "123456:TEST-not-a-real-token";
const CONFIG = { TELEGRAM_BOT_TOKEN: TOKEN, STARS_PER_USD: "77" };
const PAYMENT_ID = "8d7f2c1e-0000-4000-8000-000000000003";

function stars(config: Record<string, string | undefined>, reply: Reply) {
  const fake = fakeFetch([[() => true, reply]]);
  const ctx = context(fake.fetch, { ...CONFIG, ...config });
  return { ctx, adapter: createStars(ctx), calls: fake.calls };
}

describe("stars: price conversion", () => {
  it("rounds up to whole Stars", () => {
    expect(starsForCents(100, "77")).toBe(77);
    expect(starsForCents(1234, "100")).toBe(1234);
    expect(starsForCents(100, "76.92")).toBe(77); // 76.92 -> 77
    expect(starsForCents(1, "76.92")).toBe(1); // 0.7692 -> 1
    expect(starsForCents(3, "50")).toBe(2); // 1.5 -> 2
    expect(starsForCents(1999, "77")).toBe(1540); // 1539.23 -> 1540
  });

  it("uses exact decimal arithmetic (no float overshoot)", () => {
    // In floating point 10000 * 0.07 / 100 = 7.000000000000001, which would ceil to 8.
    expect(starsForCents(10000, "0.07")).toBe(7);
  });

  it("converts Stars back to cents, rounding down, never below the price paid", () => {
    expect(centsForStars(77, "77")).toBe(100);
    expect(centsForStars(1540, "77")).toBe(2000);
    for (const cents of [1, 99, 100, 1234, 1999, 50_000]) {
      expect(centsForStars(starsForCents(cents, "76.92"), "76.92")).toBeGreaterThanOrEqual(cents);
    }
  });

  it("rejects a bad rate or amount", () => {
    expect(() => starsForCents(100, "0")).toThrow(AdapterError);
    expect(() => starsForCents(100, "abc")).toThrow(AdapterError);
    expect(() => starsForCents(0, "77")).toThrow(AdapterError);
    expect(() => starsForCents(1.5, "77")).toThrow();
  });
});

describe("stars: createPayment", () => {
  it("creates an XTR invoice link with our payment id as payload", async () => {
    const { adapter, calls } = stars({}, { json: { ok: true, result: "https://t.me/$AbCdEf123" } });
    const created = await adapter.createPayment({ paymentId: PAYMENT_ID, amountCents: 1999, description: "Steam card 20 USD" });
    expect(created).toEqual({ providerRef: PAYMENT_ID, action: { type: "telegram_invoice", url: "https://t.me/$AbCdEf123" } });
    const call = calls[0];
    expect(call?.url).toBe(`https://api.telegram.org/bot${TOKEN}/createInvoiceLink`);
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({
      title: "Payment",
      description: "Steam card 20 USD",
      payload: PAYMENT_ID,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: "1540 Stars", amount: 1540 }],
    });
  });

  it("requires STARS_PER_USD and the bot token", async () => {
    const noRate = stars({ STARS_PER_USD: undefined }, { json: { ok: true, result: "https://t.me/$x" } });
    await expect(noRate.adapter.createPayment({ paymentId: PAYMENT_ID, amountCents: 100, description: "x" })).rejects.toThrow("STARS_PER_USD");
    const noToken = stars({ TELEGRAM_BOT_TOKEN: undefined }, { json: { ok: true, result: "https://t.me/$x" } });
    await expect(noToken.adapter.createPayment({ paymentId: PAYMENT_ID, amountCents: 100, description: "x" })).rejects.toThrow(
      "TELEGRAM_BOT_TOKEN",
    );
    expect(noRate.calls.length + noToken.calls.length).toBe(0);
  });

  it("reports Bot API errors without the token", async () => {
    const { adapter } = stars({}, { status: 400, json: { ok: false, error_code: 400, description: "Bad Request: currency_total_amount_invalid" } });
    const error = await adapter.createPayment({ paymentId: PAYMENT_ID, amountCents: 100, description: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as Error).message).toContain("currency_total_amount_invalid");
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as AdapterError).retryable).toBe(false);

    const limited = stars({}, { status: 429, json: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3" } });
    const e2 = await limited.adapter.createPayment({ paymentId: PAYMENT_ID, amountCents: 100, description: "x" }).catch((e: unknown) => e);
    expect((e2 as AdapterError).retryable).toBe(true);
  });
});

describe("stars: answerPreCheckout", () => {
  it("answers ok", async () => {
    const { ctx, calls } = stars({}, { json: { ok: true, result: true } });
    await answerPreCheckout(ctx, "q-1", true);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/answerPreCheckoutQuery`);
    expect(calls[0]?.body).toEqual({ pre_checkout_query_id: "q-1", ok: true });
  });

  it("refuses with a message (a default one when none is given)", async () => {
    const { ctx, calls } = stars({}, { json: { ok: true, result: true } });
    await answerPreCheckout(ctx, "q-2", false, "Out of stock");
    await answerPreCheckout(ctx, "q-3", false);
    expect(calls[0]?.body).toEqual({ pre_checkout_query_id: "q-2", ok: false, error_message: "Out of stock" });
    expect((calls[1]?.body as { error_message: string }).error_message.length).toBeGreaterThan(0);
  });
});

describe("stars: update parsing", () => {
  const preCheckout = {
    update_id: 10,
    pre_checkout_query: {
      id: "q-1",
      from: { id: 42, is_bot: false, first_name: "A" },
      currency: "XTR",
      total_amount: 1540,
      invoice_payload: PAYMENT_ID,
    },
  };

  const successful = {
    update_id: 11,
    message: {
      message_id: 5,
      date: 1_760_000_000,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "A" },
      successful_payment: {
        currency: "XTR",
        total_amount: 1540,
        invoice_payload: PAYMENT_ID,
        telegram_payment_charge_id: "stxABC123",
        provider_payment_charge_id: "",
      },
    },
  };

  it("reads a pre_checkout_query", () => {
    expect(parsePreCheckoutQuery(preCheckout)).toEqual({
      queryId: "q-1",
      paymentId: PAYMENT_ID,
      currency: "XTR",
      totalStars: 1540,
      fromId: 42,
    });
    expect(parsePreCheckoutQuery(successful)).toBeNull();
  });

  it("turns successful_payment into a PaymentEvent", () => {
    expect(parseSuccessfulPayment(successful)).toEqual({ providerRef: "stxABC123", paymentId: PAYMENT_ID, status: "paid" });
    const ctx = context(fakeFetch([]).fetch, CONFIG);
    expect(parseSuccessfulPayment(successful, ctx)).toEqual({
      providerRef: "stxABC123",
      paymentId: PAYMENT_ID,
      status: "paid",
      amountCents: 2000,
    });
    // A Message on its own works too.
    expect(parseSuccessfulPayment(successful.message)?.providerRef).toBe("stxABC123");
  });

  it("ignores anything that is not a Stars payment", () => {
    const fiat = { message: { ...successful.message, successful_payment: { ...successful.message.successful_payment, currency: "USD" } } };
    expect(parseSuccessfulPayment(fiat)).toBeNull();
    expect(parseSuccessfulPayment(preCheckout)).toBeNull();
    expect(parseSuccessfulPayment({ message: { text: "hi" } })).toBeNull();
    expect(parseSuccessfulPayment(null)).toBeNull();
    const noCharge = { message: { successful_payment: { ...successful.message.successful_payment, telegram_payment_charge_id: "" } } };
    expect(parseSuccessfulPayment(noCharge)).toBeNull();
  });
});
