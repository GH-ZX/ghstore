/**
 * v1.0: an order its supplier can't deliver waits for the owner; "Report a
 * problem" and its answer; review requests after delivery; the owner's health
 * alerts and the watchdog's health check; emails for website customers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PurchaseResult, SupplierAdapter } from "@store/core";
import { renderReceipt } from "../src/email";
import { logError, watchHealth } from "../src/health";
import { queueReviewAsks } from "../src/jobs";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const base = 860_000_000 + (Date.now() % 1_000_000);
const sup = `v1sup_${run}`;

let result: PurchaseResult = { status: "failed", retryable: false, reason: "out of balance" };
const supplier: SupplierAdapter = {
  id: sup,
  name: "V1 Supplier",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async () => result,
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

let owner = "";
let ownerId = "";
let customer = "";
let customerId = "";
let offerId = "";
let productId = "";
let slug = "";

const alerts = async (like: string) =>
  n((await db.query<{ c: string }>(`select count(*) as c from app.outbox where template = 'staff_alert' and data->>'text' like $1`, [like]))[0]!.c);
const n = (v: unknown) => Number(v ?? 0);

beforeAll(async () => {
  h.suppliers.set(sup, supplier);
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, 'V1 Supplier', true, null)`, [sup]);
  slug = `v1-${run}`;
  productId = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, (select id from app.categories where slug = 'games'), 'منتج', 'V1 Game ${run}', 'code', true) returning id`,
    [slug],
  ))[0]!.id;
  offerId = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'باقة', 'Pack', $2, 'ref-1', 100, 200) returning id`,
    [productId, sup],
  ))[0]!.id;
  owner = await h.login(900001, "Owner");
  ownerId = (await h.call("GET", "/api/me", { token: owner })).data.user.id;
  customer = await h.login(base + 1, "Lina");
  customerId = (await h.call("GET", "/api/me", { token: customer })).data.user.id;
  await db.query(`select * from app.adjust_wallet($1, 5000, 'test funds', $2, gen_random_uuid())`, [customerId, ownerId]);
});

afterAll(async () => {
  await db.query(`delete from app.settings where key in ('orders.failed_to_owner', 'reviews.ask_hours')`);
  await conn.close();
});

async function order(key: string): Promise<string> {
  const r = await h.call("POST", "/api/orders", { token: customer, body: { offerId, idempotencyKey: `${key}-${run}`, input: {} } });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  await h.settle();
  return r.data.orderId as string;
}

describe("an order its supplier can't deliver", () => {
  it("waits for the owner (no refund) and alerts the staff", async () => {
    result = { status: "failed", retryable: false, reason: "out of balance" };
    const id = await order("held");
    const o = await h.call("GET", `/api/orders/${id}`, { token: customer });
    expect(o.data.order.hold).toBe("owner");
    expect(["paid", "processing"]).toContain(o.data.order.status);
    expect((await h.call("GET", "/api/me", { token: customer })).data.balanceCents).toBe(4800);
    expect(await alerts(`%couldn't be bought from ${sup}%`)).toBeGreaterThan(0);
    const waiting = await h.call("GET", "/api/admin/orders?status=waiting", { token: owner });
    expect((waiting.data.orders as { id: string }[]).some((x) => x.id === id)).toBe(true);
    // The owner bought it elsewhere and delivers it by hand.
    const d = await h.call("POST", `/api/admin/orders/${id}/deliver`, { token: owner, body: { items: [{ kind: "account", value: "user@example.com / pass123" }] } });
    expect(d.status).toBe(200);
    expect((await h.call("GET", `/api/orders/${id}`, { token: customer })).data.order.status).toBe("delivered");
  });

  it("is refunded at once when the owner chose so", async () => {
    await db.query(`insert into app.settings (key, value) values ('orders.failed_to_owner', 'false') on conflict (key) do update set value = excluded.value`);
    const id = await order("refunded");
    expect((await h.call("GET", `/api/orders/${id}`, { token: customer })).data.order.status).toBe("refunded");
    await db.query(`delete from app.settings where key = 'orders.failed_to_owner'`);
  });
});

describe("report a problem", () => {
  let id = "";
  it("reaches the staff once, and the answer reaches the customer", async () => {
    result = { status: "delivered", supplierOrderId: `S-${run}`, items: [{ kind: "code", value: "CODE-1" }] };
    id = await order("problem");
    expect((await h.call("POST", `/api/orders/${id}/problem`, { token: customer, body: { reason: "other", message: "" } })).status).toBe(400);
    const r = await h.call("POST", `/api/orders/${id}/problem`, { token: customer, body: { reason: "not_working", message: "The code says used" } });
    expect(r.status).toBe(201);
    expect(r.data.problem).toMatchObject({ reason: "not_working", status: "open" });
    expect((await h.call("POST", `/api/orders/${id}/problem`, { token: customer, body: { reason: "other", message: "again" } })).status).toBe(409);
    expect(await alerts(`%Problem on order%The code says used%`)).toBeGreaterThan(0);
    // Not someone else's order.
    const other = await h.login(base + 2);
    expect((await h.call("POST", `/api/orders/${id}/problem`, { token: other, body: { reason: "not_received" } })).status).toBe(404);

    const list = await h.call("GET", "/api/admin/problems", { token: owner });
    const p = (list.data.problems as { id: string; order_id: string }[]).find((x) => x.order_id === id)!;
    expect((await h.call("GET", "/api/admin/orders", { token: owner })).data.problems).toBeGreaterThan(0);
    expect((await h.call("POST", `/api/admin/problems/${p.id}/resolve`, { token: other, body: { reply: "x" } })).status).toBe(403);
    expect((await h.call("POST", `/api/admin/problems/${p.id}/resolve`, { token: owner, body: { reply: "Here is a new code: NEW-2" } })).status).toBe(200);
    const after = await h.call("GET", `/api/orders/${id}`, { token: customer });
    expect(after.data.order.problem).toMatchObject({ status: "resolved", reply: "Here is a new code: NEW-2" });
    const msg = await db.query<{ data: { order_id: string } }>(`select data from app.outbox where template = 'problem_reply' and user_id = $1`, [customerId]);
    expect(msg[0]?.data.order_id).toBe(id);
  });
});

describe("review requests", () => {
  it("ask once per customer and product, some hours after delivery", async () => {
    await db.query(`update app.orders set delivered_at = now() - interval '5 hours' where user_id = $1 and status = 'delivered'`, [customerId]);
    expect(await queueReviewAsks(h.svc)).toBeGreaterThanOrEqual(1);
    const asks = await db.query<{ data: { slug: string } }>(`select data from app.outbox where template = 'review_ask' and user_id = $1`, [customerId]);
    expect(asks.filter((a) => a.data.slug === slug)).toHaveLength(1);
    expect(await queueReviewAsks(h.svc)).toBe(0);
    await db.query(`insert into app.settings (key, value) values ('reviews.ask_hours', '0') on conflict (key) do update set value = excluded.value`);
    expect(await queueReviewAsks(h.svc)).toBe(0);
  });

  it("go by email to a website customer, linking to the product's reviews", async () => {
    const msg = await renderReceipt(db, "https://gh-store.me", customerId, "review_ask", "en", { slug, name_en: "V1 Game", name_ar: "منتج" });
    expect(msg?.subject).toBe("How was V1 Game?");
    expect(msg?.html).toContain(`https://gh-store.me/p/${slug}?review=1`);
    const back = await renderReceipt(db, "https://gh-store.me", customerId, "back_in_stock", "ar", { slug, name_ar: "منتج", offer_ar: "باقة" });
    expect(back?.subject).toBe("عاد إلى المتجر: منتج");
  });
});

describe("health", () => {
  it("tells the owner once when server errors pile up", async () => {
    await db.query(`delete from app.alert_state where key = 'server_errors'`);
    for (let i = 0; i < 6; i++) await logError(db, "GET /api/test", `boom ${run}`);
    await watchHealth(h.svc);
    await watchHealth(h.svc);
    expect(await alerts(`%server errors%boom ${run}%`)).toBe(1);
  });

  it("answers the watchdog: 503 when the customer jobs stopped", async () => {
    await db.query(
      `insert into app.job_heartbeats (name, last_started_at, last_ok_at) values ('orders', now(), now()), ('outbox', now(), now())
       on conflict (name) do update set last_ok_at = now(), last_started_at = now()`,
    );
    // Messages left waiting by earlier runs of a reused test database are due now.
    await db.query(`update app.outbox set available_at = now() where status = 'pending' and available_at < now() - interval '15 minutes'`);
    expect((await h.call("GET", "/api/health?deep=1")).status).toBe(200);
    // A receipt or alert due for over 15 minutes: the queue is stuck.
    const late = (await db.query<{ id: string }>(
      `insert into app.outbox (template, data, available_at) values ('staff_alert', '{}'::jsonb, now() - interval '20 minutes') returning id`,
    ))[0]!.id;
    const stuck = await h.call("GET", "/api/health?deep=1");
    expect(stuck.status).toBe(503);
    expect(stuck.data.problems).toEqual(["outbox"]);
    await db.query(`delete from app.outbox where id = $1`, [late]);
    await db.query(`update app.job_heartbeats set last_ok_at = now() - interval '1 hour', last_started_at = now() - interval '1 hour' where name = 'outbox'`);
    const down = await h.call("GET", "/api/health?deep=1");
    expect(down.status).toBe(503);
    expect(down.data.problems).toEqual(["jobs"]);
    await db.query(`update app.job_heartbeats set last_ok_at = now(), last_started_at = now() where name = 'outbox'`);
    expect((await h.call("GET", "/api/health")).data).toEqual({ ok: true });
  });
});
