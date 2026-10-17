/**
 * Orders and money, after the audit (migration 0030): one supplier call at a
 * time per order, failures counted in a row, details corrected for the owner,
 * staff limits on crediting, delivered codes shown only on request, Stars that
 * survive a database blip, late provider payments, pasted USDT hashes that
 * claim nothing, supplier costs rounded up, and refunds that cancel first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaymentAdapter, PaymentEvent, PurchaseResult, SupplierAdapter, SupplierProduct } from "@store/core";
import type { Db, Services } from "../src/index";
import { fulfilOrder } from "../src/fulfilment";
import { recheckPendingPayments } from "../src/jobs";
import { settlePayment } from "../src/payments";
import { handleBotWebhook, syncSupplier } from "../src/index";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const tg = (k: number) => 860_000_000 + (Date.now() % 1_000_000) + k * 1_000_000;

// ─── suppliers
const slowId = `slow_${run}`;
const flakyId = `flaky_${run}`;
const smsId = `msms_${run}`;
const plainId = `plain_${run}`;

/** A supplier that answers a purchase only when the test lets it. */
let release: (() => void) | null = null;
const slowPurchases: string[] = [];
const slow: SupplierAdapter = {
  id: slowId,
  name: "Slow",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async (req) => {
    slowPurchases.push(req.idempotencyKey);
    await new Promise<void>((r) => (release = r));
    return { status: "delivered", supplierOrderId: `SL-${req.idempotencyKey}`, items: [{ kind: "code", value: "SLOW-CODE" }] };
  },
  checkOrder: async (id) => ({ status: "delivered", supplierOrderId: id, items: [] }),
};

/** A supplier whose answers come from queues. */
let flakyBuy: PurchaseResult[] = [];
let flakyCheck: PurchaseResult[] = [];
const flakyPurchases: string[] = [];
let flakyCatalog: SupplierProduct[] = [];
const flaky: SupplierAdapter = {
  id: flakyId,
  name: "Flaky",
  listProducts: async () => flakyCatalog,
  getBalance: async () => null,
  purchase: async (req) => {
    flakyPurchases.push(req.idempotencyKey);
    return flakyBuy.shift() ?? { status: "pending", supplierOrderId: `FL-${req.idempotencyKey}` };
  },
  checkOrder: async (id) => flakyCheck.shift() ?? { status: "pending", supplierOrderId: id },
};

/** Virtual numbers, with cancel. */
let smsCheck: PurchaseResult[] = [];
const smsCancelled: string[] = [];
const sms: SupplierAdapter = {
  id: smsId,
  name: "Numbers",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async (req) => ({ status: "pending", supplierOrderId: `N-${req.idempotencyKey}`, items: [{ kind: "phone", value: "+15550002" }] }),
  checkOrder: async (id) => smsCheck.shift() ?? { status: "pending", supplierOrderId: id },
  cancel: async (id) => {
    smsCancelled.push(id);
    return true;
  },
};

/** No cancel at all. */
const plain: SupplierAdapter = {
  id: plainId,
  name: "Plain",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async (req) => ({ status: "pending", supplierOrderId: `P-${req.idempotencyKey}` }),
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

// ─── payment providers
const samAnswers = new Map<string, PaymentEvent>();
const fakeSam: PaymentAdapter = {
  id: "sam",
  createPayment: async (input) => ({ providerRef: `minv-${input.paymentId}`, action: { type: "redirect", url: "https://pay.test/x" } }),
  checkPayment: async (ref) => samAnswers.get(ref) ?? { providerRef: ref, status: "pending" },
};
/** On chain: hash → the exact amount sent (ten-thousandths) and when. */
const chain = new Map<string, { units: number; minedAt: string; sender: string }>();
const fakeBep20: PaymentAdapter = {
  id: "bep20",
  createPayment: async (input) => ({ providerRef: input.paymentId, action: { type: "address", network: "BSC (BEP20)", asset: "USDT", address: "0xstore", amount: ((input.sendUnits ?? 0) / 10_000).toFixed(4) } }),
  checkPayment: async (txHash, expected) => {
    const t = chain.get(txHash);
    if (!t) return { providerRef: txHash, txHash, status: "pending", detail: { reason: "not_found" } };
    const detail = { receivedCents: Math.floor(t.units / 100), senders: [t.sender], minedAt: t.minedAt };
    if (expected?.sendUnits === t.units) return { providerRef: txHash, txHash, status: "paid", amountCents: expected.amountCents };
    if (expected?.sendUnits !== undefined && t.units < expected.sendUnits) {
      return { providerRef: txHash, txHash, status: "partial", amountCents: detail.receivedCents, detail: { ...detail, reason: "underpaid" } };
    }
    return { providerRef: txHash, txHash, status: "review", amountCents: detail.receivedCents, detail: { ...detail, reason: "amount_mismatch" } };
  },
};

let owner = "";
let support = "";
let supportId = "";
let monitor = "";
let customer = "";
let customerId = "";
const offers: Record<string, string> = {};
let cat = "";

async function userId(token: string): Promise<string> {
  return (await h.call("GET", "/api/me", { token })).data.user.id as string;
}
async function fund(uid: string, cents: number) {
  const p = await db.query<{ id: string }>(`insert into app.payments (user_id, method, amount_cents, status) values ($1, 'sam', $2, 'pending') returning id`, [uid, cents]);
  await db.query(`select * from app.credit_payment($1, $2, $3)`, [p[0]!.id, cents, `om-${p[0]!.id}`]);
}
const balance = async (token: string) => (await h.call("GET", "/api/wallet", { token })).data.balanceCents as number;
const order = (offerId: string, key: string, token = customer) => h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `${key}-${run}` } });
const row = async (id: string) =>
  (await db.query<{ status: string; hold: string | null; attempts: number; fail_streak: number; lease_until: Date | null; supplier_order_id: string | null; cost_cents: string | null }>(
    `select status, hold, attempts, fail_streak, lease_until, supplier_order_id, cost_cents from app.orders where id = $1`, [id],
  ))[0]!;

async function product(slug: string, kind: string, extra: { after?: unknown[] } = {}) {
  return (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active, after_fields) values ($1, $2, 'x', $1, $3, true, $4::text::jsonb) returning id`,
    [slug, cat, kind, JSON.stringify(extra.after ?? [])],
  ))[0]!.id;
}
async function offer(productId: string, supplier: string, ref: string, cost: number | null, price: number) {
  return (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'x', $3, $2, $3, $4, $5) returning id`,
    [productId, supplier, ref, cost, price],
  ))[0]!.id;
}

beforeAll(async () => {
  for (const s of [slow, flaky, sms, plain]) {
    h.suppliers.set(s.id, s);
    await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, $1, true, null)`, [s.id]);
  }
  h.payments.set("sam", fakeSam);
  h.payments.set("bep20", fakeBep20);
  cat = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  offers.slow = await offer(await product(`om-slow-${run}`, "code"), slowId, "s-1", 100, 150);
  offers.flaky = await offer(await product(`om-flaky-${run}`, "code"), flakyId, "f-1", 100, 150);
  offers.sms = await offer(await product(`om-sms-${run}`, "sms"), smsId, "usa/tg", 40, 60);
  offers.plain = await offer(await product(`om-plain-${run}`, "code"), plainId, "p-1", 100, 150);
  const askFirst = await product(`om-ask-${run}`, "account", { after: [{ key: "email", type: "email", labelEn: "Email", labelAr: "البريد", required: true }] });
  offers.ask = await offer(askFirst, flakyId, "f-ask", 100, 150);

  owner = await h.login(900001, "Owner");
  support = await h.login(tg(1), "Support");
  supportId = await userId(support);
  await db.query(`update app.users set role = 'support' where id = $1`, [supportId]);
  monitor = await h.login(tg(2), "Monitor");
  await db.query(`update app.users set role = 'monitor' where id = $1`, [await userId(monitor)]);
  customer = await h.login(tg(3), "Buyer");
  customerId = await userId(customer);
  await fund(customerId, 5000);
});

afterAll(async () => {
  await conn.close();
});

describe("one supplier call at a time per order", () => {
  it("never buys an order twice while one run is asking the supplier", async () => {
    slowPurchases.length = 0;
    const placed = await order(offers.slow!, "race");
    expect(placed.status).toBe(201);
    const id = placed.data.orderId as string;
    // The background fulfilment (placeOrder's waitUntil) is now waiting on the supplier.
    for (let i = 0; i < 50 && slowPurchases.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(slowPurchases).toEqual([id]);
    expect((await row(id)).lease_until).not.toBeNull();

    // The scheduled job, the admin's retry and the order page all find it taken.
    expect(await fulfilOrder(h.svc, env, id)).toBe("busy");
    const retried = await h.call("POST", `/api/admin/orders/${id}/retry`, { token: owner, body: {} });
    expect(retried.data.result).toBe("busy");
    // The job's own list leaves a leased order out.
    const due = await db.query(`select 1 from app.orders where id = $1 and (lease_until is null or lease_until <= now())`, [id]);
    expect(due).toHaveLength(0);
    expect(slowPurchases).toHaveLength(1);

    release!();
    await h.settle();
    const done = await row(id);
    expect(done.status).toBe("delivered");
    expect(done.lease_until).toBeNull();
    expect(slowPurchases).toHaveLength(1);
  });

  it("frees the order after each run, so the next check can ask again", async () => {
    flakyBuy = [{ status: "pending", supplierOrderId: "FL-free" }];
    const placed = await order(offers.flaky!, "free");
    await h.settle();
    const id = placed.data.orderId as string;
    expect(await row(id)).toMatchObject({ status: "processing", lease_until: null, supplier_order_id: "FL-free" });
    expect(await fulfilOrder(h.svc, env, id)).toBe("processing");
    // A run that died (lease left behind) blocks only until the lease runs out.
    await db.query(`update app.orders set lease_until = now() + interval '1 minute' where id = $1`, [id]);
    expect(await fulfilOrder(h.svc, env, id)).toBe("busy");
    await db.query(`update app.orders set lease_until = now() - interval '1 second' where id = $1`, [id]);
    flakyCheck = [{ status: "delivered", supplierOrderId: "FL-free", items: [{ kind: "code", value: "FREE" }], costCents: 0 }];
    expect(await fulfilOrder(h.svc, env, id)).toBe("delivered");
    // A cost of 0 reported by the supplier tells nothing: the known cost stays.
    expect(Number((await row(id)).cost_cents)).toBe(100);
  });
});

describe("failures in a row, not checks", () => {
  it("keeps an order the supplier accepted after many pending checks and errors", async () => {
    flakyBuy = [{ status: "pending", supplierOrderId: "FL-long" }];
    const placed = await order(offers.flaky!, "long");
    await h.settle();
    const id = placed.data.orderId as string;
    flakyCheck = Array.from({ length: 8 }, () => ({ status: "pending", supplierOrderId: "FL-long" }) as PurchaseResult);
    for (let i = 0; i < 8; i++) expect(await fulfilOrder(h.svc, env, id)).toBe("processing");
    expect((await row(id)).attempts).toBeGreaterThanOrEqual(9);
    // One passing error after all those checks: retried, not refunded.
    flakyCheck = Array.from({ length: 12 }, () => ({ status: "failed", retryable: true, reason: "timeout" }) as PurchaseResult);
    for (let i = 0; i < 12; i++) expect(await fulfilOrder(h.svc, env, id)).toBe("retry");
    expect(await row(id)).toMatchObject({ status: "processing", hold: null, fail_streak: 12, supplier_order_id: "FL-long" });
    // It settles: the streak starts again.
    flakyCheck = [{ status: "delivered", supplierOrderId: "FL-long", items: [{ kind: "code", value: "LONG" }] }];
    expect(await fulfilOrder(h.svc, env, id)).toBe("delivered");
    expect(await row(id)).toMatchObject({ status: "delivered", fail_streak: 0 });
    expect(flakyPurchases.filter((k) => k === id)).toHaveLength(1);
  });

  it("gives an order the supplier never accepted to the owner after six failures in a row", async () => {
    flakyBuy = Array.from({ length: 6 }, () => ({ status: "failed", retryable: true, reason: "supplier busy" }) as PurchaseResult);
    const placed = await order(offers.flaky!, "never");
    await h.settle();
    const id = placed.data.orderId as string;
    for (let i = 0; i < 4; i++) expect(await fulfilOrder(h.svc, env, id)).toBe("retry");
    expect((await row(id)).fail_streak).toBe(5);
    expect(await fulfilOrder(h.svc, env, id)).toBe("refund");
    expect(await row(id)).toMatchObject({ status: "paid", hold: "owner", fail_streak: 6 });
  });

  it("releases a virtual number at the supplier before refunding it", async () => {
    smsCancelled.length = 0;
    const before = await balance(customer);
    const placed = await order(offers.sms!, "smsfail");
    await h.settle();
    const id = placed.data.orderId as string;
    const sid = (await row(id)).supplier_order_id!;
    smsCheck = [{ status: "failed", retryable: false, reason: "number banned by the service" }];
    expect(await fulfilOrder(h.svc, env, id)).toBe("refund");
    expect(smsCancelled).toEqual([sid]);
    expect((await row(id)).status).toBe("refunded");
    expect(await balance(customer)).toBe(before);
  });
});

describe("details given after paying", () => {
  it("stay with the owner when corrected on an order the supplier could not deliver", async () => {
    flakyBuy = [{ status: "failed", retryable: false, reason: "account not eligible" }];
    flakyPurchases.length = 0;
    const placed = await order(offers.ask!, "ask");
    const id = placed.data.orderId as string;
    expect((await row(id)).hold).toBe("info");
    expect((await h.call("POST", `/api/orders/${id}/answers`, { token: customer, body: { values: { email: "first@mail.test" } } })).status).toBe(200);
    await h.settle();
    expect(flakyPurchases).toEqual([id]);
    expect((await row(id)).hold).toBe("owner"); // the supplier refused: the owner finishes it

    // The customer corrects their email: saved for the owner, the supplier is not asked again.
    expect((await h.call("POST", `/api/orders/${id}/answers`, { token: customer, body: { values: { email: "fixed@mail.test" } } })).status).toBe(200);
    await h.settle();
    expect((await row(id)).hold).toBe("owner");
    expect(flakyPurchases).toEqual([id]);
    const detail = await h.call("GET", `/api/admin/orders/${id}`, { token: owner });
    expect(detail.data.order.details[0].value).toBe("fixed@mail.test");
  });
});

describe("crediting top-ups by hand", () => {
  async function topup(uid: string, status: string, cents = 1000) {
    return (await db.query<{ id: string }>(`insert into app.payments (user_id, method, amount_cents, status) values ($1, 'sam', $2, $3) returning id`, [uid, cents, status]))[0]!.id;
  }
  const approve = (token: string, id: string, amountCents: number) =>
    h.call("POST", `/api/admin/payments/${id}/approve`, { token, body: { amountCents, note: "checked by hand" } });

  it("lets support credit only a top-up under review, up to its amount, never their own", async () => {
    const before = await balance(customer);
    const review = await topup(customerId, "review");
    expect((await approve(support, review, 1001)).status).toBe(403);
    expect((await approve(support, await topup(customerId, "pending"), 1000)).status).toBe(403);
    expect((await approve(support, await topup(customerId, "expired"), 1000)).status).toBe(403);
    expect((await approve(support, await topup(supportId, "review"), 1000)).status).toBe(403);
    expect((await approve(monitor, review, 1000)).status).toBe(403);
    expect(await balance(customer)).toBe(before);

    const ok = await approve(support, review, 1000);
    expect(ok.status).toBe(200);
    expect(ok.data.credited).toBe(true);
    expect(await balance(customer)).toBe(before + 1000);
    // The database says the same, whatever the API does.
    await expect(db.query(`select * from app.credit_payment($1, 500, null, null, $2)`, [await topup(customerId, "pending", 500), supportId])).rejects.toThrow(/not_allowed/);
  });

  it("leaves the owner full ability", async () => {
    const before = await balance(customer);
    const closed = await topup(customerId, "expired", 300);
    const ok = await approve(owner, closed, 450);
    expect(ok.status).toBe(200);
    expect(await balance(customer)).toBe(before + 450);
  });
});

describe("delivered codes in the admin", () => {
  it("are hidden until shown, and every look is audit logged", async () => {
    flakyBuy = [{ status: "delivered", supplierOrderId: "FL-codes", items: [{ kind: "code", value: "SECRET-1" }, { kind: "code", value: "SECRET-2", label: "Bonus" }] }];
    const placed = await order(offers.flaky!, "codes");
    await h.settle();
    const id = placed.data.orderId as string;
    const looks = async () => (await db.query(`select 1 from app.audit_log where action = 'order.deliveries_view' and target_id = $1`, [id])).length;

    const detail = await h.call("GET", `/api/admin/orders/${id}`, { token: support });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.data)).not.toContain("SECRET");
    expect(detail.data.deliveries.map((d: { label: string | null; masked: boolean }) => [d.label, d.masked])).toEqual([[null, true], ["Bonus", true]]);
    expect(await looks()).toBe(0);

    const one = await h.call("POST", `/api/admin/orders/${id}/reveal`, { token: support, body: { deliveryId: detail.data.deliveries[1].id } });
    expect(one.data.deliveries.map((d: { value: string }) => d.value)).toEqual(["SECRET-2"]);
    expect(await looks()).toBe(1);
    const all = await h.call("POST", `/api/admin/orders/${id}/reveal`, { token: support, body: {} });
    expect(all.data.deliveries.map((d: { value: string }) => d.value)).toEqual(["SECRET-1", "SECRET-2"]);
    expect(await looks()).toBe(2);
    // Monitors and customers never see them.
    expect((await h.call("POST", `/api/admin/orders/${id}/reveal`, { token: monitor, body: {} })).status).toBe(403);
    expect((await h.call("POST", `/api/admin/orders/${id}/reveal`, { token: customer, body: {} })).status).toBe(403);
    expect(await looks()).toBe(2);
  });
});

describe("refunds from the admin", () => {
  it("cancel at the supplier first where it can, and say so in the audit where it can't", async () => {
    smsCancelled.length = 0;
    const numberOrder = (await order(offers.sms!, "refund-sms")).data.orderId as string;
    const plainOrder = (await order(offers.plain!, "refund-plain")).data.orderId as string;
    await h.settle();
    const sid = (await row(numberOrder)).supplier_order_id!;

    const a = await h.call("POST", `/api/admin/orders/${numberOrder}/refund`, { token: owner, body: { note: "customer asked" } });
    expect(a.data).toMatchObject({ refunded: true, supplierCancel: "cancelled" });
    expect(smsCancelled).toEqual([sid]);
    const b = await h.call("POST", `/api/admin/orders/${plainOrder}/refund`, { token: owner, body: { note: "customer asked" } });
    expect(b.data).toMatchObject({ refunded: true, supplierCancel: "unsupported" });
    const audit = await db.query<{ data: { supplierCancel?: string } }>(
      `select data from app.audit_log where action = 'order.refund' and target_id = $1`, [plainOrder],
    );
    expect(audit[0]!.data.supplierCancel).toBe("unsupported");
    expect((await row(plainOrder)).status).toBe("refunded");
  });
});

describe("Telegram Stars", () => {
  it("asks Telegram to send a paid invoice again when it could not be credited, and credits it once", async () => {
    await db.query(`insert into app.settings (key, value) values ('payments.stars_per_usd', '100') on conflict (key) do update set value = excluded.value`);
    const id = tg(4);
    const token = await h.login(id, "Stars");
    h.payments.set("stars", { id: "stars", createPayment: async (i) => ({ providerRef: i.paymentId, action: { type: "telegram_invoice", url: "https://t.me/$inv" } }) });
    const t = await h.call("POST", "/api/topups", { token, body: { method: "stars", amountCents: 300 } });
    expect(t.status).toBe(201);
    const update = { message: { chat: { id, type: "private" }, from: { id }, successful_payment: { currency: "XTR", total_amount: 300, invoice_payload: t.data.paymentId, telegram_payment_charge_id: `och-${run}` } } };
    const post = (svc: Services) =>
      handleBotWebhook(
        new Request("https://store.test/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET! }, body: JSON.stringify(update) }),
        env,
        svc,
      );
    // The database fails just as the credit is written.
    const real = h.svc.db;
    const blip: Db = {
      query: (text, params) => (/credit_payment/.test(text) ? Promise.reject(new Error("connection reset")) : real.query(text, params)) as never,
      tx: (fn) => real.tx(fn),
    };
    const failed = await post({ ...h.svc, db: blip });
    expect(failed.status).toBe(500); // Telegram delivers it again
    expect((await db.query(`select 1 from app.error_log where source = 'bot.successful_payment' and message like '%connection reset%'`)).length).toBeGreaterThan(0);
    expect(await balance(token)).toBe(0);
    expect((await post(h.svc)).status).toBe(200);
    expect((await post(h.svc)).status).toBe(200);
    expect(await balance(token)).toBe(300);
  });
});

describe("provider top-ups", () => {
  it("puts a top-up the provider had expired, then reports paid, in front of staff", async () => {
    const p = (await db.query<{ id: string }>(
      `insert into app.payments (user_id, method, amount_cents, status, provider_ref) values ($1, 'sam', 700, 'expired', $2) returning id`,
      [customerId, `late-${run}`],
    ))[0]!.id;
    const before = await balance(customer);
    samAnswers.set(`late-${run}`, { providerRef: `late-${run}`, status: "paid", amountCents: 700 });
    expect(await settlePayment(h.svc, p)).toBe("review");
    const after = (await db.query<{ status: string; note: string }>(`select status, note from app.payments where id = $1`, [p]))[0]!;
    expect(after).toEqual({ status: "review", note: "paid after it expired" });
    expect(await balance(customer)).toBe(before); // never credited blindly
  });
});

describe("manual USDT", () => {
  const hash = (k: string) => "0x" + (run + k).split("").map((c) => c.charCodeAt(0).toString(16).slice(-1)).join("").padEnd(64, "0").slice(0, 64);

  it("lets a pasted hash claim nothing: the transfer's owner is still credited, the other request waits for staff", async () => {
    const victim = await h.login(tg(5), "Victim");
    const thief = await h.login(tg(6), "Thief");
    const va = await h.call("POST", "/api/topups", { token: victim, body: { method: "bep20", amountCents: 1000 } });
    const ta = await h.call("POST", "/api/topups", { token: thief, body: { method: "bep20", amountCents: 1000 } });
    const sent = Math.round(Number(va.data.action.amount) * 10_000);
    const h1 = hash("v1");
    chain.set(h1, { units: sent, minedAt: new Date().toISOString(), sender: "0x1111111111111111111111111111111111111111" });

    // The thief pastes the victim's public hash first.
    const t = await h.call("POST", `/api/topups/${ta.data.paymentId}/tx`, { token: thief, body: { txHash: h1 } });
    expect(t.status).toBe(200);
    expect(t.data.status).not.toBe("paid");
    const tp = (await db.query<{ status: string; note: string }>(`select status, note from app.payments where id = $1`, [ta.data.paymentId]))[0]!;
    // What staff see: the chain's figures, not a "partial" amount to credit.
    expect(tp.status).toBe("review");
    expect(tp.note).toMatch(/^usdt (underpaid|amount_mismatch): received \d+ cents from 0x1111111111111111111111111111111111111111 at \S+$/);
    expect(await balance(thief)).toBe(0);

    // The victim is not blocked by it.
    const v = await h.call("POST", `/api/topups/${va.data.paymentId}/tx`, { token: victim, body: { txHash: h1 } });
    expect(v.data.status).toBe("paid");
    expect(await balance(victim)).toBe(1000);
    // Now credited, the hash is used.
    const again = await h.call("POST", "/api/topups", { token: thief, body: { method: "bep20", amountCents: 500 } });
    const reused = await h.call("POST", `/api/topups/${again.data.paymentId}/tx`, { token: thief, body: { txHash: h1 } });
    expect(reused.data.error?.code).toBe("tx_reused");
  });

  it("closes requests under review that can no longer settle, freeing their exact amount", async () => {
    const who = await h.login(tg(7), "Late");
    const a = await h.call("POST", "/api/topups", { token: who, body: { method: "bep20", amountCents: 800 } });
    const b = await h.call("POST", "/api/topups", { token: who, body: { method: "bep20", amountCents: 800 } });
    // a: a transfer that did not match; b: a hash never mined.
    await db.query(`update app.payments set status = 'review', note = 'transfer did not match', created_at = now() - interval '50 minutes' where id = $1`, [a.data.paymentId]);
    await h.call("POST", `/api/topups/${b.data.paymentId}/tx`, { token: who, body: { txHash: hash("never") } });
    await db.query(`update app.payments set created_at = now() - interval '7 hours' where id = $1`, [b.data.paymentId]);
    await recheckPendingPayments(h.svc, 5);
    const rows = await db.query<{ id: string; status: string; note: string }>(
      `select id, status, note from app.payments where id = any($1::uuid[])`, [[a.data.paymentId, b.data.paymentId]],
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[a.data.paymentId]).toMatchObject({ status: "expired", note: "transfer did not match" });
    expect(by[b.data.paymentId]).toMatchObject({ status: "expired", note: "hash never confirmed" });
  });
});

describe("supplier costs", () => {
  it("one package the price check can't save never stops the others", async () => {
    const p = await product(`om-sync-${run}`, "code");
    const bad = await offer(p, flakyId, "sync-bad", 100, 150);
    const good = await offer(p, flakyId, "sync-good", 100, 150);
    flakyCatalog = [
      { externalId: "sync-bad", name: "Bad", costCents: -1, available: true, kind: "code" },
      { externalId: "sync-good", name: "Good", costCents: 120, available: true, kind: "code" },
      // Every package the store sells from this supplier stays listed.
      ...["f-1", "f-ask"].map((ref) => ({ externalId: ref, name: ref, costCents: 100, available: true, kind: "code" as const })),
    ];
    const report = await syncSupplier(h.svc, flakyId);
    expect(report.failed).toBe(1);
    expect(report.error).toContain(bad);
    const prices = await db.query<{ id: string; cost_cents: string; price_cents: string }>(
      `select id, cost_cents, price_cents from app.offers where id = any($1::uuid[])`, [[bad, good]],
    );
    const by = Object.fromEntries(prices.map((r) => [r.id, r]));
    expect(Number(by[good]!.cost_cents)).toBe(120);
    expect(Number(by[bad]!.cost_cents)).toBe(100); // untouched
  });
});
