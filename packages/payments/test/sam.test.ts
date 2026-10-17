import { describe, expect, it } from "vitest";
import { AdapterError } from "../../core/src/adapters";
import { createSam, resolveSamWallet, samChargeAmount } from "../src/sam";
import { context, fakeFetch, type Handler, type Reply } from "./fake-fetch";

const SHAMCASH_ADDRESS = "0123456789abcdef0123456789abcdef";
const SECRET = "test-webhook-secret-not-real-000000";
const BASE_CONFIG = {
  SAM_API_KEY: "test-sam-key",
  SAM_WEBHOOK_SECRET: SECRET,
  SAM_WALLET: "0933000000",
};

// Shapes from sam-api.pro as used by the old code (providers/sam/client.ts).
const WALLETS = [
  {
    id: "w-syr",
    provider: "syriatel",
    phone: "0944000000",
    status: "active",
  },
  {
    id: "w-sham",
    provider: "shamcash",
    walletAddress: SHAMCASH_ADDRESS,
    phone: "0933000000",
    label: "Store",
    status: "active",
  },
];

function invoiceReply(fields: Record<string, unknown>): Reply {
  return {
    json: {
      id: "inv_1",
      method: "shamcash",
      identifier: SHAMCASH_ADDRESS,
      amount: "12.34",
      currency: "USD",
      status: "pending",
      expiresAt: "2026-10-15T12:15:00Z",
      paidAt: null,
      paidAmount: null,
      ...fields,
    },
  };
}

function samWith(config: Record<string, string | undefined>, routes: Array<[string | RegExp, Handler | Reply]>) {
  const fake = fakeFetch(routes);
  return { adapter: createSam(context(fake.fetch, { ...BASE_CONFIG, ...config })), calls: fake.calls };
}

const INPUT = {
  paymentId: "8d7f2c1e-0000-4000-8000-000000000001",
  amountCents: 1234,
  description: "Top-up",
  callbackUrl: "https://store.example/api/payments/sam/webhook",
};

describe("sam: createPayment", () => {
  it("opens a USD invoice against the resolved linked wallet", async () => {
    const { adapter, calls } = samWith({}, [
      ["/v1/wallets", { json: WALLETS }],
      [
        "/v1/invoices",
        {
          status: 201,
          json: { invoiceId: "inv_1", paymentUrl: "https://sam-api.pro/pay/inv_1", expiresAt: "2026-10-15T12:15:00Z" },
        },
      ],
    ]);
    const created = await adapter.createPayment(INPUT);
    expect(created).toEqual({
      providerRef: "inv_1",
      action: { type: "redirect", url: "https://sam-api.pro/pay/inv_1" },
      expiresAt: "2026-10-15T12:15:00Z",
    });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://sam-api.pro/api/v1/invoices");
    expect(post?.headers.authorization).toBe("Bearer test-sam-key");
    const body = post?.body as Record<string, string>;
    expect(body.method).toBe("shamcash");
    // The saved phone number resolves to the 32-hex address SAM expects.
    expect(body.identifier).toBe(SHAMCASH_ADDRESS);
    expect(body.amount).toBe("12.34");
    expect(body.currency).toBe("USD");
    const hook = new URL(body.webhookUrl ?? "");
    expect(hook.origin + hook.pathname).toBe(INPUT.callbackUrl);
    expect(hook.searchParams.get("token")).toBe(SECRET);
    expect(hook.searchParams.get("pid")).toBe(INPUT.paymentId);
  });

  it("bills whole new Syrian pounds at the configured rate", async () => {
    const { adapter, calls } = samWith({ SAM_CURRENCY: "SYP", SAM_SYP_PER_USD: "118.5" }, [
      ["/v1/wallets", { json: WALLETS }],
      ["/v1/invoices", { json: { invoiceId: "inv_2", paymentUrl: "https://sam-api.pro/pay/inv_2" } }],
    ]);
    await adapter.createPayment(INPUT);
    const body = calls.find((c) => c.method === "POST")?.body as Record<string, string>;
    // 12.34 USD x 118.5 = 1462.29 -> 1462 pounds, sent as a string.
    expect(body.amount).toBe("1462");
    expect(body.currency).toBe("SYP");
  });

  it("refuses SYP without a rate, and an old-pound (pre-2026) rate", async () => {
    expect(() => samChargeAmount(1234, "SYP", undefined)).toThrow(AdapterError);
    const { adapter, calls } = samWith({ SAM_CURRENCY: "SYP" }, []);
    await expect(adapter.createPayment(INPUT)).rejects.toThrow("SAM_SYP_PER_USD");
    const old = samWith({ SAM_CURRENCY: "SYP", SAM_SYP_PER_USD: "13000" }, []);
    await expect(old.adapter.createPayment(INPUT)).rejects.toThrow("redenomination");
    expect(calls.length + old.calls.length).toBe(0);
  });

  it("allows a higher rate only when SAM_SYP_MAX_RATE is raised deliberately", async () => {
    const { adapter, calls } = samWith({ SAM_CURRENCY: "SYP", SAM_SYP_PER_USD: "2500", SAM_SYP_MAX_RATE: "5000" }, [
      ["/v1/wallets", { json: WALLETS }],
      ["/v1/invoices", { json: { invoiceId: "inv_4", paymentUrl: "https://sam-api.pro/pay/inv_4" } }],
    ]);
    await adapter.createPayment({ ...INPUT, amountCents: 100 });
    expect((calls.find((c) => c.method === "POST")?.body as Record<string, string>).amount).toBe("2500");
  });

  it("requires a callback URL, the webhook secret, and a linked wallet", async () => {
    const noHook = samWith({}, []);
    await expect(noHook.adapter.createPayment({ ...INPUT, callbackUrl: undefined })).rejects.toThrow("callback URL");
    const noSecret = samWith({ SAM_WEBHOOK_SECRET: undefined }, []);
    await expect(noSecret.adapter.createPayment(INPUT)).rejects.toThrow("SAM_WEBHOOK_SECRET");
    const unlinked = samWith({ SAM_WALLET: "0999999999" }, [["/v1/wallets", { json: WALLETS }]]);
    await expect(unlinked.adapter.createPayment(INPUT)).rejects.toThrow("not a shamcash wallet linked");
    expect(unlinked.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("falls back to SAM's pay page when the response has no payment URL", async () => {
    const { adapter } = samWith({ SAM_WALLET: undefined, SAM_WEBHOOK_URL: "https://store.example/hook" }, [
      ["/v1/wallets", { json: WALLETS }],
      ["/v1/invoices", { json: { invoiceId: "inv 3" } }],
    ]);
    const created = await adapter.createPayment({ ...INPUT, callbackUrl: undefined });
    expect(created.action).toEqual({ type: "redirect", url: "https://sam-api.pro/pay/inv%203" });
  });

  it("does not echo the webhook secret when SAM quotes it back in an error", async () => {
    const { adapter } = samWith({}, [
      ["/v1/wallets", { json: WALLETS }],
      [
        "/v1/invoices",
        { status: 400, json: { code: "VALIDATION_ERROR", message: `webhookUrl rejected: ...?token=${SECRET}` } },
      ],
    ]);
    const error = await adapter.createPayment(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect((error as AdapterError).retryable).toBe(false);
  });
});

describe("sam: resolveSamWallet", () => {
  it("matches any field and returns the provider's preferred identifier", () => {
    expect(resolveSamWallet(WALLETS, "shamcash", "0933000000")).toBe(SHAMCASH_ADDRESS);
    expect(resolveSamWallet(WALLETS, "syriatel", "w-syr")).toBe("0944000000");
    expect(resolveSamWallet(WALLETS, "shamcash", undefined)).toBe(SHAMCASH_ADDRESS);
    expect(resolveSamWallet(WALLETS, "syriatel", SHAMCASH_ADDRESS)).toBeNull();
    expect(resolveSamWallet({ data: WALLETS }, "shamcash", undefined)).toBe(SHAMCASH_ADDRESS);
  });
});

describe("sam: checkPayment status mapping", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["pending", { status: "pending" }, { status: "pending" }],
    ["paid in full", { status: "paid", paidAmount: "12.34" }, { status: "paid", amountCents: 1234 }],
    ["paid, overpaid", { status: "paid", paidAmount: "20" }, { status: "paid", amountCents: 2000 }],
    ["paid, no paid figure: SAM's invoiced amount", { status: "paid" }, { status: "paid", amountCents: 1234 }],
    ["paid short", { status: "paid", paidAmount: "10.00" }, { status: "partial", amountCents: 1000 }],
    ["paid with no figures at all", { status: "paid", amount: null }, { status: "partial" }],
    ["paid in an unknown currency", { status: "paid", currency: "EUR" }, { status: "partial" }],
    ["expired", { status: "expired" }, { status: "expired" }],
    ["cancelled", { status: "cancelled" }, { status: "failed" }],
    ["failed", { status: "FAILED" }, { status: "failed" }],
  ];
  for (const [name, fields, expected] of cases) {
    it(name, async () => {
      const { adapter, calls } = samWith({}, [["/pay/inv_1", invoiceReply(fields)]]);
      const event = await adapter.checkPayment("inv_1");
      expect(event).toEqual({ providerRef: "inv_1", ...expected } as never);
      expect(calls[0]?.url).toBe("https://sam-api.pro/api/pay/inv_1");
      expect(calls[0]?.headers.authorization).toBe("Bearer test-sam-key");
    });
  }

  it("treats HTTP 410 as expired", async () => {
    const { adapter } = samWith({}, [["/pay/inv_1", { status: 410, json: { code: "EXPIRED" } }]]);
    expect(await adapter.checkPayment("inv_1")).toEqual({ providerRef: "inv_1", status: "expired" });
  });

  it("converts a paid SYP invoice back to cents at the configured rate", async () => {
    const { adapter } = samWith({ SAM_SYP_PER_USD: "118.5" }, [
      ["/pay/inv_1", invoiceReply({ status: "paid", amount: "1462", paidAmount: "1462", currency: "SYP" })],
    ]);
    expect(await adapter.checkPayment("inv_1")).toEqual({ providerRef: "inv_1", status: "paid", amountCents: 1234 });
  });

  it("credits the top-up's own amount for a SYP invoice paid in full, whatever today's rate", async () => {
    // Issued at 118.5 (1462 pounds for $12.34); the rate has since moved to 100.
    const { adapter } = samWith({ SAM_SYP_PER_USD: "100" }, [
      ["/pay/inv_1", invoiceReply({ status: "paid", amount: "1462", paidAmount: "1462", currency: "SYP" })],
    ]);
    expect(await adapter.checkPayment("inv_1", { amountCents: 1234 })).toEqual({ providerRef: "inv_1", status: "paid", amountCents: 1234 });
    // Paid short: the converted figure stays, for staff.
    const short = samWith({ SAM_SYP_PER_USD: "100" }, [
      ["/pay/inv_1", invoiceReply({ status: "paid", amount: "1462", paidAmount: "1400", currency: "SYP" })],
    ]);
    expect(await short.adapter.checkPayment("inv_1", { amountCents: 1234 })).toEqual({ providerRef: "inv_1", status: "partial", amountCents: 1400 });
    // No invoiced figure from SAM: nothing to show it was paid in full, so the converted figure stays.
    const unsized = samWith({ SAM_SYP_PER_USD: "100" }, [
      ["/pay/inv_1", invoiceReply({ status: "paid", amount: null, paidAmount: "1000", currency: "SYP" })],
    ]);
    expect(await unsized.adapter.checkPayment("inv_1", { amountCents: 1234 })).toEqual({ providerRef: "inv_1", status: "paid", amountCents: 1000 });
    // USD invoices credit what SAM reports.
    const usdInvoice = samWith({}, [["/pay/inv_1", invoiceReply({ status: "paid", amount: "12.34", paidAmount: "12.34", currency: "USD" })]]);
    expect(await usdInvoice.adapter.checkPayment("inv_1", { amountCents: 1234 })).toEqual({ providerRef: "inv_1", status: "paid", amountCents: 1234 });
  });

  it("needs the SYP rate only to size a paid SYP invoice", async () => {
    const pending = samWith({}, [["/pay/inv_1", invoiceReply({ status: "pending", amount: "1462", currency: "SYP" })]]);
    expect(await pending.adapter.checkPayment("inv_1")).toEqual({ providerRef: "inv_1", status: "pending" });
    const paid = samWith({}, [["/pay/inv_1", invoiceReply({ status: "paid", amount: "1462", currency: "SYP" })]]);
    await expect(paid.adapter.checkPayment("inv_1")).rejects.toThrow("SAM_SYP_PER_USD");
  });

  it("compares SYP paid against SYP invoiced, independent of the rate", async () => {
    const { adapter } = samWith({ SAM_SYP_PER_USD: "100" }, [
      ["/pay/inv_1", invoiceReply({ status: "paid", amount: "1462", paidAmount: "1400", currency: "SYP" })],
    ]);
    expect(await adapter.checkPayment("inv_1")).toEqual({ providerRef: "inv_1", status: "partial", amountCents: 1400 });
  });

  it("retries a read after a 503 and gives up with a retryable error", async () => {
    let n = 0;
    const flaky = samWith({}, [["/pay/inv_1", () => (++n === 1 ? { status: 503, json: {} } : invoiceReply({}))]]);
    expect((await flaky.adapter.checkPayment("inv_1")).status).toBe("pending");
    expect(flaky.calls.length).toBe(2);

    const down = samWith({}, [["/pay/inv_1", { status: 502, text: "<html>bad gateway</html>" }]]);
    const error = await down.adapter.checkPayment("inv_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).retryable).toBe(true);
    expect(down.calls.length).toBe(3);
  });
});

describe("sam: verifyWebhook", () => {
  const hookUrl = (token: string | null, pid = INPUT.paymentId) => {
    const url = new URL(INPUT.callbackUrl);
    if (token !== null) url.searchParams.set("token", token);
    url.searchParams.set("pid", pid);
    return url.toString();
  };
  const post = (url: string, body: unknown, method = "POST") =>
    new Request(url, { method, body: method === "POST" ? JSON.stringify(body) : undefined });
  const paidClaim = { event: "invoice.paid", invoiceId: "inv_1", amount: "99999", currency: "USD", transactionRef: "T1" };

  it("rejects a wrong or missing token without calling SAM", async () => {
    const { adapter, calls } = samWith({}, []);
    expect(await adapter.verifyWebhook(post(hookUrl("wrong"), paidClaim))).toBeNull();
    expect(await adapter.verifyWebhook(post(hookUrl(null), paidClaim))).toBeNull();
    expect(await adapter.verifyWebhook(post(hookUrl(SECRET.slice(0, -1)), paidClaim))).toBeNull();
    expect(await adapter.verifyWebhook(post(hookUrl(SECRET), paidClaim, "GET"))).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("rejects malformed bodies and unsupported events", async () => {
    const { adapter, calls } = samWith({}, []);
    expect(await adapter.verifyWebhook(new Request(hookUrl(SECRET), { method: "POST", body: "{not json" }))).toBeNull();
    expect(await adapter.verifyWebhook(post(hookUrl(SECRET), { event: "invoice.paid" }))).toBeNull();
    expect(await adapter.verifyWebhook(post(hookUrl(SECRET), { ...paidClaim, event: "invoice.refunded" }))).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("re-checks with SAM and reports SAM's answer, not the payload's (spoofed paid stays pending)", async () => {
    const { adapter, calls } = samWith({}, [["/pay/inv_1", invoiceReply({ status: "pending" })]]);
    const event = await adapter.verifyWebhook(post(hookUrl(SECRET), paidClaim));
    expect(event).toEqual({ providerRef: "inv_1", paymentId: INPUT.paymentId, status: "pending" });
    expect(calls.length).toBe(1);
  });

  it("accepts a genuine paid callback with SAM's own amount", async () => {
    const { adapter } = samWith({}, [["/pay/inv_1", invoiceReply({ status: "paid", paidAmount: "12.34" })]]);
    const event = await adapter.verifyWebhook(post(hookUrl(SECRET), paidClaim));
    expect(event).toEqual({ providerRef: "inv_1", paymentId: INPUT.paymentId, status: "paid", amountCents: 1234 });
  });

  it("propagates an upstream failure as retryable so SAM retries", async () => {
    const { adapter } = samWith({}, [["/pay/inv_1", { status: 500, json: {} }]]);
    const error = await adapter.verifyWebhook(post(hookUrl(SECRET), paidClaim)).catch((e: unknown) => e);
    expect((error as AdapterError).retryable).toBe(true);
  });
});

describe("sam: verifyReference", () => {
  it("settles on SAM's verify answer and its figures", async () => {
    const { adapter, calls } = samWith({}, [
      ["/pay/inv_1/verify", { json: { verified: true, message: "ok", paidAmount: "12.34" } }],
      ["/pay/inv_1", invoiceReply({ status: "pending" })],
    ]);
    const result = await adapter.verifyReference("inv_1", " TX-77 ");
    expect(result.verified).toBe(true);
    expect(result.event).toEqual({ providerRef: "inv_1", status: "paid", amountCents: 1234 });
    expect(calls[0]?.body).toEqual({ transactionRef: "TX-77" });
  });

  it("reports an unmatched reference as not verified and leaves the invoice pending", async () => {
    const { adapter } = samWith({}, [
      ["/pay/inv_1/verify", { json: { verified: false, message: "not found" } }],
      ["/pay/inv_1", invoiceReply({ status: "pending" })],
    ]);
    const result = await adapter.verifyReference("inv_1", "TX-1");
    expect(result).toEqual({ verified: false, message: "not found", event: { providerRef: "inv_1", status: "pending" } });
  });
});

describe("SAM account (Admin → Settings → APIs)", () => {
  it("shows the linked wallets, the receiving wallet's balances and its latest movements", async () => {
    const { adapter, calls } = samWith({ SAM_WALLET: SHAMCASH_ADDRESS }, [
      ["/v1/wallets/shamcash/" + SHAMCASH_ADDRESS + "/balance", { json: [{ currency: "USD", amount: 4.1, label: null }, { currency: "SYP", amount: 1606.5, label: null }] }],
      ["/v1/wallets/shamcash/" + SHAMCASH_ADDRESS + "/transactions", {
        json: [{ id: "1", type: "credit", amount: 1600, currency: "SYP", counterparty: "Hussein", description: null, status: null, occurredAt: "2026-04-30T20:17:29" }],
      }],
      ["/v1/wallets", { json: WALLETS }],
    ]);
    const info = await adapter.accountInfo!();
    expect(info.fields.map((f) => f.label)).toEqual(["syriatel", "shamcash"]);
    expect(info.fields[1]!.value).toContain("Store");
    expect(info.balances).toEqual([{ currency: "USD", amount: 4.1 }, { currency: "SYP", amount: 1606.5 }]);
    expect(info.history).toEqual([{ at: "2026-04-30T20:17:29", amount: 1600, currency: "SYP", text: "Hussein", direction: "in", ref: "1", note: null }]);
    // Read only: nothing but GETs.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});
