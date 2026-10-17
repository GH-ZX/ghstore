/**
 * The owner's numbers: the profit report, supplier balances at their pace,
 * automatic badges, the daily summary's in-person line, and USDT top-ups
 * matched by their exact amount.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterError, type Deposit, type PaymentAdapter, type PaymentEvent, type SupplierAdapter } from "@store/core";
import { handleUpdate } from "../src/bot";
import { recheckPendingPayments } from "../src/jobs";
import { creditStarsPayment, detectUsdtDeposits, settlePayment } from "../src/payments";
import { daySummary, localNow, summaryText } from "../src/reports";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const sup = `psup_${run}`;
/** A transaction hash unique to this run (a used hash can never be claimed again). */
const hash = (tag: string) => `0x${tag}${Date.now().toString(16)}`.padEnd(66, "0");

const supplier: SupplierAdapter = {
  id: sup,
  name: "Profit Codes",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async (req) => ({ status: "delivered", supplierOrderId: `P-${req.idempotencyKey}`, items: [{ kind: "code", value: "C" }] }),
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

let deposits: Deposit[] = [];
let scannedFrom: number | undefined;
/** Transfers the chain check refuses for the request (sent before it was made). */
const tooOld = new Set<string>();
/** The log server is busy (HTTP 429) while set. */
let busy = false;
const usdt: PaymentAdapter = {
  id: "bep20",
  createPayment: async (input) => ({ providerRef: input.paymentId, action: { type: "address", network: "BSC (BEP20)", asset: "USDT", address: "0xabc", amount: ((input.sendUnits ?? 0) / 10_000).toFixed(4) } }),
  checkPayment: async (ref, expected): Promise<PaymentEvent> =>
    tooOld.has(ref) ? { providerRef: ref, status: "failed", txHash: ref } : { providerRef: ref, status: "paid", txHash: ref, amountCents: expected?.amountCents ?? 0 },
  recentDeposits: async (since) => {
    if (busy) throw new AdapterError("bep20", "RPC eth_getLogs answered HTTP 429", true);
    scannedFrom = since;
    return { toBlock: 5000, deposits };
  },
};

/** What the fake ShamCash says about an invoice. */
let samStatus: PaymentEvent["status"] = "pending";
const sam: PaymentAdapter = {
  id: "sam",
  createPayment: async (input) => ({ providerRef: `SAM-${input.paymentId}`, action: { type: "redirect", url: "https://sam.example/pay" } }),
  checkPayment: async (ref, expected): Promise<PaymentEvent> => ({ providerRef: ref, status: samStatus, amountCents: expected?.amountCents }),
};

let owner = "";
let customer = "";
const customerTg = 860_000_000 + (Date.now() % 1_000_000);
let product = "";
let offer = "";

async function fund(token: string, cents: number) {
  const me = await h.call("GET", "/api/me", { token });
  const p = await db.query<{ id: string }>(`insert into app.payments (user_id, method, amount_cents, status) values ($1, 'sam', $2, 'pending') returning id`, [me.data.user.id, cents]);
  await db.query(`select * from app.credit_payment($1, $2, $3)`, [p[0]!.id, cents, `pf-${p[0]!.id}`]);
}

beforeAll(async () => {
  h.suppliers.set(sup, supplier);
  h.payments.set("bep20", usdt);
  h.payments.set("sam", sam);
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct, balance_cents) values ($1, 'Profit Codes', true, null, 700000)`, [sup]);
  const cat = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  product = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, $2, 'x', 'Profit Gift', 'code', true) returning id`,
    [`pgift-${run}`, cat],
  ))[0]!.id;
  offer = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'x', '$1000', $2, 'p1000', 80000, 100000) returning id`,
    [product, sup],
  ))[0]!.id;
  // Earlier runs of a reused test database sold the same gift: their orders move out of the report's 30 days.
  await db.query(
    `update app.orders set created_at = created_at - interval '60 days'
      where created_at > now() - interval '40 days' and product_id in (select id from app.products where slug like 'pgift-%' and id <> $1)`,
    [product],
  );
  owner = await h.login(900001, "Owner");
  customer = await h.login(customerTg, "Buyer");
  await fund(customer, 1_000_000);
  // 8 + 1 in person: more than any other test's product sells, so it is the best seller; and at $1000
  // each it makes the most profit, so it heads the report whatever else a reused database holds.
  for (let i = 0; i < 8; i++) {
    expect((await h.call("POST", "/api/orders", { token: customer, body: { offerId: offer, idempotencyKey: `pf-${i}-${run}` } })).status).toBe(201);
  }
  expect((await h.call("POST", "/api/admin/orders/in-person", { token: owner, body: { offerId: offer, idempotencyKey: `pf-ip-${run}` } })).status).toBe(201);
  await h.settle();
});

afterAll(async () => {
  await conn.close();
});

describe("profit report", () => {
  it("adds up sales, cost and profit, by day, supplier, product and category", async () => {
    const r = await h.call("GET", "/api/admin/reports/profit", { token: owner });
    expect(r.status).toBe(200);
    const mine = r.data.bySupplier.find((s: { id: string }) => s.id === sup);
    expect(mine).toMatchObject({ name: "Profit Codes", salesCents: 900_000, costCents: 720_000, profitCents: 180_000, orders: 9 });
    expect(r.data.byProduct.find((p: { id: string }) => p.id === product)).toMatchObject({ salesCents: 900_000, profitCents: 180_000, orders: 9 });
    expect(r.data.totals.inPersonCents).toBeGreaterThanOrEqual(100_000);
    expect(r.data.days).toHaveLength(30);
    const today = r.data.days.at(-1);
    expect(today.salesCents).toBeGreaterThanOrEqual(900_000);
    expect((await h.call("GET", "/api/admin/reports/profit?from=2026-02-31", { token: owner })).status).toBe(400);
    expect((await h.call("GET", "/api/admin/reports/profit", { token: customer })).status).toBe(403);
  });

  it("tells how long each supplier's balance lasts at last week's pace", async () => {
    const o = await h.call("GET", "/api/admin/overview", { token: owner });
    const s = o.data.suppliers.find((x: { id: string }) => x.id === sup);
    // $7200 spent this week (9 × $800) → $1028.57 a day; $7000 lasts 6 days.
    expect(s).toMatchObject({ balanceCents: 700_000, spent7dCents: 720_000, daysLeft: 6 });
  });

  it("puts the in-person sales in the daily summary", async () => {
    const s = await daySummary(h.svc, localNow(new Date()).date);
    expect(s.inPersonOrders).toBeGreaterThanOrEqual(1);
    expect(summaryText(s, "en")).toMatch(/In person \(cash with you\): \$/);
  });
});

describe("automatic badges", () => {
  it("marks the most sold as Best seller and the newest as New, unless the owner chose otherwise", async () => {
    const card = async () => (await h.call("GET", "/api/catalog")).data.products.find((p: { id: string }) => p.id === product);
    expect((await card()).badge).toBe("best"); // 8 customer orders + 1 in person this month
    await db.query(`update app.products set badge = 'none' where id = $1`, [product]);
    expect((await card()).badge).toBeNull();
    await db.query(`update app.products set badge = 'sale' where id = $1`, [product]);
    expect((await card()).badge).toBe("sale");
    await db.query(`update app.products set badge = null where id = $1`, [product]);
    await db.query(`insert into app.settings (key, value) values ('badges.auto_best', 'false'::jsonb) on conflict (key) do update set value = excluded.value`);
    // Without Best seller it is still one of the newest products.
    expect(["new", null]).toContain((await card()).badge);
    await db.query(`delete from app.settings where key = 'badges.auto_best'`);
  });
});

describe("USDT top-ups: 15 minutes to send, or cancel", () => {
  it("gives a send-by time, lets the customer cancel an unpaid request, and closes old ones", async () => {
    const t = await h.call("POST", "/api/topups", { token: customer, body: { method: "bep20", amountCents: 700 } });
    expect(t.status).toBe(201);
    const sendBy = Date.parse(t.data.sendBy);
    expect(Math.abs(sendBy - (Date.now() + 15 * 60_000))).toBeLessThan(60_000);
    const got = (await h.call("GET", `/api/topups/${t.data.paymentId}`, { token: customer })).data;
    expect(Date.parse(got.sendBy)).toBe(sendBy);
    expect(t.data.secondsLeft).toBe(900);
    expect(got.secondsLeft).toBeGreaterThan(890);
    expect(got.secondsLeft).toBeLessThanOrEqual(900);

    // Only its owner, only once.
    const other = await h.login(870_000_000 + (Date.now() % 1_000_000), "Other");
    expect((await h.call("POST", `/api/topups/${t.data.paymentId}/cancel`, { token: other })).status).toBe(409);
    const c = await h.call("POST", `/api/topups/${t.data.paymentId}/cancel`, { token: customer });
    expect(c.status).toBe(200);
    expect((await h.call("GET", `/api/topups/${t.data.paymentId}`, { token: customer })).data.status).toBe("expired");
    expect((await h.call("POST", `/api/topups/${t.data.paymentId}/cancel`, { token: customer })).status).toBe(409);

    // A request whose hash was given can't be cancelled.
    const withHash = await h.call("POST", "/api/topups", { token: customer, body: { method: "bep20", amountCents: 800 } });
    await db.query(`update app.payments set tx_hash = $2, status = 'review' where id = $1`, [withHash.data.paymentId, hash("f1")]);
    expect((await h.call("POST", `/api/topups/${withHash.data.paymentId}/cancel`, { token: customer })).status).toBe(409);

    // 45 minutes without a transfer: closed, its amount free again.
    const old = await h.call("POST", "/api/topups", { token: customer, body: { method: "bep20", amountCents: 900 } });
    await db.query(`update app.payments set created_at = now() - interval '46 minutes' where id = $1`, [old.data.paymentId]);
    await recheckPendingPayments(h.svc, 0);
    const closed = (await db.query<{ status: string; note: string }>(`select status, note from app.payments where id = $1`, [old.data.paymentId]))[0]!;
    expect(closed).toEqual({ status: "expired", note: "send window closed" });
  });
});

describe("every top-up: 15 minutes, cancel, and late payments still credited", () => {
  it("ShamCash: cancelled, then paid anyway: the confirmed money is credited", async () => {
    const t = await h.call("POST", "/api/topups", { token: customer, body: { method: "sam", amountCents: 1500 } });
    expect(t.status).toBe(201);
    expect(t.data.sendBy).toBeTruthy();
    expect((await h.call("POST", `/api/topups/${t.data.paymentId}/cancel`, { token: customer })).status).toBe(200);
    const before = (await h.call("GET", "/api/wallet", { token: customer })).data.balanceCents;
    samStatus = "paid";
    try {
      expect(await settlePayment(h.svc, t.data.paymentId)).toBe("paid");
    } finally {
      samStatus = "pending";
    }
    expect((await h.call("GET", "/api/wallet", { token: customer })).data.balanceCents).toBe(before + 1500);
  });

  it("closes unpaid ShamCash and Stars top-ups just after their 15 minutes", async () => {
    const fresh = await h.call("POST", "/api/topups", { token: customer, body: { method: "sam", amountCents: 1600 } });
    const old = await h.call("POST", "/api/topups", { token: customer, body: { method: "sam", amountCents: 1700 } });
    await db.query(`update app.payments set created_at = now() - interval '18 minutes' where id = $1`, [old.data.paymentId]);
    await recheckPendingPayments(h.svc, 0);
    const status = async (id: string) => (await db.query<{ status: string }>(`select status from app.payments where id = $1`, [id]))[0]!.status;
    expect(await status(old.data.paymentId)).toBe("expired");
    expect(await status(fresh.data.paymentId)).toBe("pending");
    await h.call("POST", `/api/topups/${fresh.data.paymentId}/cancel`, { token: customer });
  });

  it("Stars: Telegram's checkout is refused after the window, and a payment it took is never dropped", async () => {
    const me = await h.call("GET", "/api/me", { token: customer });
    const insert = async (minutesAgo: number, status = "pending", note: string | null = null) =>
      (await db.query<{ id: string }>(
        `insert into app.payments (user_id, method, amount_cents, status, action, note, created_at)
         values ($1, 'stars', 100, $2, '{"stars": 80}'::jsonb, $3, now() - make_interval(mins => $4)) returning id`,
        [me.data.user.id, status, note, minutesAgo],
      ))[0]!.id;
    const precheck = async (paymentId: string) => {
      h.telegramCalls = [];
      await handleUpdate({ update_id: 1, pre_checkout_query: { id: "q1", from: { id: customerTg }, currency: "XTR", total_amount: 80, invoice_payload: paymentId } } as never, env, h.svc);
      return h.telegramCalls.find((c) => c.method === "answerPreCheckoutQuery")?.payload.ok;
    };
    expect(await precheck(await insert(5))).toBe(true);
    expect(await precheck(await insert(16))).toBe(false);
    // Closed by the window, but Telegram already took the Stars: credited.
    const closed = await insert(20, "expired", "send window closed");
    expect(await creditStarsPayment(h.svc, { paymentId: closed, chargeId: `ch-${run}`, totalStars: 80, telegramUserId: String(customerTg) })).toBe("paid");
  });
});

describe("USDT top-ups matched by their exact amount", () => {
  it("credits the request whose amount a confirmed deposit matches, without a pasted hash", async () => {
    const t = await h.call("POST", "/api/topups", { token: customer, body: { method: "bep20", amountCents: 1000 } });
    expect(t.status).toBe(201);
    const amount = t.data.amountCents as number;
    expect(amount).toBe(1000);
    // What the customer sends: 10.01xx, in ten-thousandths of a dollar.
    const send = Math.round(Number(t.data.action.amount) * 10_000);
    expect(send).toBeGreaterThanOrEqual(100_100);
    expect(send).toBeLessThanOrEqual(100_199);
    const dep = (txHash: string, amount4: number, exact4: boolean, blockNumber: number, from: string): Deposit =>
      ({ txHash, cents: Math.floor(amount4 / 100), exact: false, amount4, exact4, blockNumber, from });
    const before = (await h.call("GET", "/api/wallet", { token: customer })).data.balanceCents;
    const older = hash("e0");
    tooOld.add(older);
    deposits = [
      dep(older, send, true, 4989, "0xdd"), // same amount, sent before the request
      dep(hash("e1"), send + 50_000, true, 4990, "0xaa"), // matches nothing
      dep(hash("e2"), send, false, 4991, "0xbb"), // a fraction below a ten-thousandth more
      dep(hash("e3"), send, true, 4992, "0xcc"),
    ];
    expect(await detectUsdtDeposits(h.svc)).toBe(1);
    expect((await h.call("GET", "/api/wallet", { token: customer })).data.balanceCents).toBe(before + amount);
    const p = await h.call("GET", `/api/topups/${t.data.paymentId}`, { token: customer });
    expect(p.data.txHash).toBe(deposits[3]!.txHash);
    // The older transfer was never attached to anything.
    expect((await db.query(`select 1 from app.payments where tx_hash = $1`, [older])).length).toBe(0);
    // The next scan continues where this one stopped; nothing open, nothing scanned.
    expect(await detectUsdtDeposits(h.svc)).toBe(0);
    const t2 = await h.call("POST", "/api/topups", { token: customer, body: { method: "bep20", amountCents: 2000 } });
    expect(t2.status).toBe(201);
    deposits = [];
    await detectUsdtDeposits(h.svc);
    expect(scannedFrom).toBe(5000);

    // A busy public log server is tried again quietly; half an hour of it is reported.
    busy = true;
    try {
      expect(await detectUsdtDeposits(h.svc)).toBe(0);
      expect(await detectUsdtDeposits({ ...h.svc, now: () => new Date(Date.now() + 10 * 60_000) })).toBe(0);
      await expect(detectUsdtDeposits({ ...h.svc, now: () => new Date(Date.now() + 31 * 60_000) })).rejects.toThrow(/429/);
    } finally {
      busy = false;
    }
    await detectUsdtDeposits(h.svc);
    expect((await db.query(`select 1 from app.settings where key = 'bep20.scan_failing_since'`)).length).toBe(0);
  });
});
