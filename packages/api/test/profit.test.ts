/**
 * The owner's numbers: the profit report, supplier balances at their pace,
 * automatic badges, the daily summary's in-person line, and USDT top-ups
 * matched by their exact amount.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deposit, PaymentAdapter, PaymentEvent, SupplierAdapter } from "@store/core";
import { detectUsdtDeposits } from "../src/payments";
import { daySummary, localNow, summaryText } from "../src/reports";
import { connectTestDb, Harness } from "./helpers";

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
const usdt: PaymentAdapter = {
  id: "bep20",
  createPayment: async (input) => ({ providerRef: input.paymentId, action: { type: "address", network: "BSC (BEP20)", asset: "USDT", address: "0xabc", amount: "10.37" } }),
  checkPayment: async (ref, expected): Promise<PaymentEvent> =>
    tooOld.has(ref) ? { providerRef: ref, status: "failed", txHash: ref } : { providerRef: ref, status: "paid", txHash: ref, amountCents: expected?.amountCents ?? 0 },
  recentDeposits: async (since) => {
    scannedFrom = since;
    return { toBlock: 5000, deposits };
  },
};

let owner = "";
let customer = "";
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
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct, balance_cents) values ($1, 'Profit Codes', true, null, 7000)`, [sup]);
  const cat = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  product = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, $2, 'x', 'Profit Gift', 'code', true) returning id`,
    [`pgift-${run}`, cat],
  ))[0]!.id;
  offer = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'x', '$10', $2, 'p10', 800, 1000) returning id`,
    [product, sup],
  ))[0]!.id;
  await db.query(`delete from app.identities where provider = 'telegram' and subject = '900001'`);
  owner = await h.login(900001, "Owner");
  customer = await h.login(860_000_000 + (Date.now() % 1_000_000), "Buyer");
  await fund(customer, 10_000);
  for (let i = 0; i < 3; i++) {
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
    expect(mine).toMatchObject({ name: "Profit Codes", salesCents: 4000, costCents: 3200, profitCents: 800, orders: 4 });
    expect(r.data.byProduct.find((p: { id: string }) => p.id === product)).toMatchObject({ salesCents: 4000, profitCents: 800, orders: 4 });
    expect(r.data.totals.inPersonCents).toBeGreaterThanOrEqual(1000);
    expect(r.data.days).toHaveLength(30);
    const today = r.data.days.at(-1);
    expect(today.salesCents).toBeGreaterThanOrEqual(4000);
    expect((await h.call("GET", "/api/admin/reports/profit?from=2026-02-31", { token: owner })).status).toBe(400);
    expect((await h.call("GET", "/api/admin/reports/profit", { token: customer })).status).toBe(403);
  });

  it("tells how long each supplier's balance lasts at last week's pace", async () => {
    const o = await h.call("GET", "/api/admin/overview", { token: owner });
    const s = o.data.suppliers.find((x: { id: string }) => x.id === sup);
    // $32 spent this week (4 × $8) → $4.57 a day; $70 lasts 15 days.
    expect(s).toMatchObject({ balanceCents: 7000, spent7dCents: 3200, daysLeft: 15 });
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
    expect((await card()).badge).toBe("best"); // 3 customer orders + 1 in person this month
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

describe("USDT top-ups matched by their exact amount", () => {
  it("credits the request whose amount a confirmed deposit matches, without a pasted hash", async () => {
    const t = await h.call("POST", "/api/topups", { token: customer, body: { method: "bep20", amountCents: 1000 } });
    expect(t.status).toBe(201);
    const amount = t.data.amountCents as number;
    const before = (await h.call("GET", "/api/wallet", { token: customer })).data.balanceCents;
    const older = hash("e0");
    tooOld.add(older);
    deposits = [
      { txHash: older, cents: amount, exact: true, blockNumber: 4989, from: "0xdd" }, // same amount, sent before the request
      { txHash: hash("e1"), cents: amount + 500, exact: true, blockNumber: 4990, from: "0xaa" }, // matches nothing
      { txHash: hash("e2"), cents: amount, exact: false, blockNumber: 4991, from: "0xbb" }, // not exact
      { txHash: hash("e3"), cents: amount, exact: true, blockNumber: 4992, from: "0xcc" },
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
  });
});
