import { describe, expect, it } from "vitest";
import {
  backoffSeconds,
  canTransition,
  centsToDecimal,
  decryptText,
  encryptText,
  formatSignedUsd,
  formatSyp,
  formatUsd,
  hmacSha256,
  maskTail,
  minimumPrice,
  nextStep,
  onCostChange,
  priceFromCost,
  readSessionToken,
  signSession,
  toCents,
  toCentsUp,
  toHex,
  utf8,
  verifyInitData,
  verifyLoginWidget,
  verifySession,
} from "../src/index";

describe("money", () => {
  it("parses decimal strings into integer cents with half-up rounding", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents("12.3")).toBe(1230);
    expect(toCents("12")).toBe(1200);
    expect(toCents("0.125")).toBe(13);
    expect(toCents("0.124")).toBe(12);
    expect(toCents("-4.90")).toBe(-490);
    expect(toCents(4.9)).toBe(490);
    expect(() => toCents("12,5")).toThrow();
    // Supplier costs: any fraction of a cent rounds up, and a price is never 0.
    expect(toCentsUp("0.004")).toBe(1);
    expect(toCentsUp("12.341")).toBe(1235);
    expect(toCentsUp(4.9)).toBe(490);
    expect(() => toCentsUp("-1")).toThrow();
    expect(priceFromCost(0, { mode: "percent", value: 10, minMarginPct: 5 })).toBe(1);
    expect(() => toCents("abc")).toThrow();
  });
  it("formats cents", () => {
    expect(centsToDecimal(5)).toBe("0.05");
    expect(formatUsd(1313)).toBe("$13.13");
    expect(formatSignedUsd(-490)).toBe("−$4.90");
    expect(formatSignedUsd(1000)).toBe("+$10.00");
  });
  it("formats Syrian pounds from a rate in new pounds", () => {
    expect(formatSyp(1000, 120, "en")).toBe("SYP 1,200");
    expect(() => formatSyp(100, 0)).toThrow();
  });
});

describe("pricing", () => {
  const rule = { mode: "percent" as const, value: 15, minMarginPct: 5, roundToCents: 5 };
  it("applies markup and rounds up to the step", () => {
    expect(priceFromCost(123, rule)).toBe(145); // 141.45 -> 142 -> 145
    expect(priceFromCost(100, { mode: "fixed", value: 20, minMarginPct: 5 })).toBe(120);
  });
  it("never goes below the minimum margin", () => {
    expect(priceFromCost(1000, { mode: "fixed", value: 0, minMarginPct: 5 })).toBe(1050);
    expect(minimumPrice(490, 5)).toBe(515);
  });
  it("reprices computed rules and pauses manual prices that lose margin", () => {
    expect(onCostChange(145, 123, rule)).toEqual({ action: "keep", price: 145 });
    expect(onCostChange(145, 200, rule)).toEqual({ action: "reprice", price: 230 });
    const manual = { mode: "manual" as const, value: 0, minMarginPct: 5 };
    expect(onCostChange(500, 470, manual)).toEqual({ action: "keep", price: 500 });
    expect(onCostChange(500, 480, manual)).toEqual({ action: "pause", reason: "cost_above_margin" });
  });
});

describe("orders", () => {
  it("allows only valid transitions", () => {
    expect(canTransition("paid", "processing")).toBe(true);
    expect(canTransition("delivered", "refunded")).toBe(false);
    expect(canTransition("failed", "refunded")).toBe(true);
  });
  it("maps supplier answers to next steps", () => {
    expect(nextStep({ status: "delivered", supplierOrderId: "1", items: [] }, 0)).toEqual({ next: "delivered" });
    expect(nextStep({ status: "pending", supplierOrderId: "1" }, 2)).toEqual({ next: "processing", checkAfterSeconds: 120 });
    expect(nextStep({ status: "failed", retryable: true, reason: "x" }, 0)).toEqual({ next: "retry", checkAfterSeconds: 30, reason: "x" });
    expect(nextStep({ status: "failed", retryable: true, reason: "x" }, 5)).toEqual({ next: "refund", reason: "x" });
    expect(nextStep({ status: "failed", retryable: false, reason: "bad id" }, 0)).toEqual({ next: "refund", reason: "bad id" });
    expect(backoffSeconds(99)).toBe(900);
  });
  it("counts failures in a row, not checks, and never refunds an accepted order for a retryable failure", () => {
    const blip = { status: "failed", retryable: true, reason: "timeout" } as const;
    // Polled 40 times while pending, then one blip: retried, not refunded.
    expect(nextStep(blip, 40, { failures: 0 })).toEqual({ next: "retry", checkAfterSeconds: 30, reason: "timeout" });
    expect(nextStep(blip, 40, { failures: 5 })).toEqual({ next: "refund", reason: "timeout" });
    // The supplier has it: keep asking, whatever the streak.
    expect(nextStep(blip, 40, { failures: 50, accepted: true })).toEqual({ next: "retry", checkAfterSeconds: 900, reason: "timeout" });
    // A supplier that says the order failed is still refunded.
    expect(nextStep({ status: "failed", retryable: false, reason: "cancelled" }, 3, { failures: 0, accepted: true })).toEqual({ next: "refund", reason: "cancelled" });
  });
});

async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = await hmacSha256(utf8("WebAppData"), botToken);
  const hash = toHex(await hmacSha256(secret, dcs));
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("telegram initData", () => {
  const bot = "123456:TEST-token-not-real";
  const now = new Date("2026-10-15T12:00:00Z");
  const fields = {
    auth_date: String(Math.floor(now.getTime() / 1000) - 60),
    query_id: "AAE",
    user: JSON.stringify({ id: 42, first_name: "Samer", username: "samer_sy", language_code: "ar" }),
  };
  it("accepts correctly signed, fresh data", async () => {
    const v = await verifyInitData(await signInitData(fields, bot), bot, { now });
    expect(v?.user).toEqual({ id: 42, firstName: "Samer", username: "samer_sy", languageCode: "ar" });
  });
  it("rejects a wrong bot token, tampering and stale data", async () => {
    const data = await signInitData(fields, bot);
    expect(await verifyInitData(data, "999:other", { now })).toBeNull();
    expect(await verifyInitData(data.replace("samer_sy", "admin"), bot, { now })).toBeNull();
    expect(await verifyInitData(data, bot, { now: new Date(now.getTime() + 2 * 3600_000) })).toBeNull();
  });
});

describe("telegram login widget", () => {
  const bot = "123456:TEST-token-not-real";
  const now = new Date("2026-10-15T12:00:00Z");
  async function sign(f: Record<string, string>): Promise<Record<string, string>> {
    const dcs = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join("\n");
    const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bot)));
    return { ...f, hash: toHex(await hmacSha256(secret, dcs)) };
  }
  const base = { id: "42", first_name: "Samer", username: "samer_sy", auth_date: String(Math.floor(now.getTime() / 1000) - 30) };
  it("accepts a signed widget payload and reads the user", async () => {
    const v = await verifyLoginWidget(await sign(base), bot, { now });
    expect(v?.user).toEqual({ id: 42, firstName: "Samer", username: "samer_sy" });
  });
  it("rejects tampering, another bot and stale logins", async () => {
    const signed = await sign(base);
    expect(await verifyLoginWidget({ ...signed, id: "43" }, bot, { now })).toBeNull();
    expect(await verifyLoginWidget(signed, "999:other", { now })).toBeNull();
    expect(await verifyLoginWidget(signed, bot, { now: new Date(now.getTime() + 2 * 3600_000) })).toBeNull();
  });
});

describe("sessions", () => {
  const secret = "x".repeat(40);
  it("signs and verifies, and rejects tampering and expiry", async () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const t = await signSession({ sub: "u1", sid: "s1", ch: "miniapp" }, secret, now);
    const c = await verifySession(t, secret, now);
    expect(c?.sub).toBe("u1");
    expect(await verifySession(t, "y".repeat(40), now)).toBeNull();
    expect(await verifySession(t.slice(0, -2) + "AA", secret, now)).toBeNull();
    expect(await verifySession(t, secret, new Date(now.getTime() + 13 * 3600_000))).toBeNull();
  });
  it("refuses short secrets", async () => {
    await expect(signSession({ sub: "u", sid: "s", ch: "web" }, "short")).rejects.toThrow();
  });
  it("reads tokens from header or cookie", () => {
    expect(readSessionToken(new Request("https://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(readSessionToken(new Request("https://x", { headers: { cookie: "a=1; store_session=t%2E1" } }))).toBe("t.1");
  });
});

describe("encryption at rest", () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));
  it("round-trips and uses a fresh IV each time", async () => {
    const a = await encryptText("GPT-7Q4K-M2XD", key);
    const b = await encryptText("GPT-7Q4K-M2XD", key);
    expect(a).not.toBe(b);
    expect(await decryptText(a, key)).toBe("GPT-7Q4K-M2XD");
  });
  it("masks secrets for display", () => {
    expect(maskTail("GPT-7Q4K-M2XD")).toBe("••••M2XD");
  });
});
