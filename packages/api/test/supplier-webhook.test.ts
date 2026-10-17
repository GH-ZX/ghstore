/**
 * POST /api/webhooks/suppliers/:id: a supplier's "your order changed" call.
 * The adapter checks its secret (parseWebhook); the store then asks the
 * supplier itself (checkOrder) and never trusts the body.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PurchaseResult, SupplierAdapter } from "@store/core";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const sup = `whsup_${run}`;
const plain = `whplain_${run}`;
const SECRET = "wh-secret-for-tests";

/** What the supplier says when asked about each of its orders. */
const truth = new Map<string, PurchaseResult>();
let checks: string[] = [];
let seq = 0;
const adapter: SupplierAdapter = {
  id: sup,
  name: "Webhook supplier",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async () => ({ status: "pending", supplierOrderId: `WH-${run}-${++seq}` }),
  checkOrder: async (id) => {
    checks.push(id);
    return truth.get(id) ?? { status: "pending", supplierOrderId: id };
  },
  // Like the real adapters: a shared secret, and only the order id is taken from the body.
  parseWebhook: async (req) => {
    if (req.headers.get("x-webhook-secret") !== SECRET) return null;
    const body = (await req.json()) as { order: string };
    return { supplierOrderId: body.order, result: { status: "failed", supplierOrderId: body.order, reason: "the body says so" } };
  },
};
// A supplier whose adapter takes no webhooks.
const noHooks: SupplierAdapter = { ...adapter, id: plain, parseWebhook: undefined };

let token = "";
let offerId = "";

/** The call as a supplier makes it: no browser origin, the secret in a header. */
async function post(supplier: string, order: string, secret: string | null = SECRET) {
  const { handle } = await import("../src/index");
  const { env } = await import("./helpers");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-webhook-secret"] = secret;
  const res = await handle(
    new Request(`${env.PUBLIC_BASE_URL}/api/webhooks/suppliers/${supplier}`, { method: "POST", headers, body: JSON.stringify({ order }) }),
    env,
    h.svc,
  );
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

async function placeOrder(): Promise<{ id: string; supplierOrderId: string }> {
  const r = await h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `wh-${run}-${seq}` } });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  await h.settle();
  const row = (await db.query<{ status: string; supplier_order_id: string }>(`select status, supplier_order_id from app.orders where id = $1`, [r.data.orderId]))[0]!;
  expect(row.status).toBe("processing");
  return { id: r.data.orderId as string, supplierOrderId: row.supplier_order_id };
}

const order = async (id: string) =>
  (await db.query<{ status: string; hold: string | null; next_check_at: string | null }>(`select status, hold, next_check_at from app.orders where id = $1`, [id]))[0]!;

beforeAll(async () => {
  h.suppliers.set(sup, adapter);
  h.suppliers.set(plain, noHooks);
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, 'Webhook supplier', true, null), ($2, 'No hooks', true, null)`, [sup, plain]);
  const p = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, (select id from app.categories where slug = 'games'), 'هوك', 'Hook Game', 'code', true) returning id`,
    [`wh-${run}`],
  ))[0]!.id;
  offerId = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'أ', 'A', $2, 'w1', 100, 150) returning id`,
    [p, sup],
  ))[0]!.id;
  token = await h.login(880_000_000 + (Date.now() % 1_000_000), "Hooked", "en");
  const me = await h.call("GET", "/api/me", { token });
  const pay = (await db.query<{ id: string }>(`insert into app.payments (user_id, method, amount_cents, status) values ($1, 'sam', 5000, 'pending') returning id`, [me.data.user.id]))[0]!;
  await db.query(`select * from app.credit_payment($1, 5000, $2)`, [pay.id, `wh-${pay.id}`]);
});

afterAll(async () => {
  await db.query(`delete from app.settings where key = 'orders.failed_to_owner'`);
  await db.query(`update app.suppliers set enabled = false where id in ($1, $2)`, [sup, plain]);
  await conn.close();
});

describe("supplier webhooks", () => {
  it("are refused for a supplier without them, and without the secret", async () => {
    expect((await post(`nosuch_${run}`, "X")).status).toBe(404);
    expect((await post(plain, "X")).status).toBe(404);
    const { id, supplierOrderId } = await placeOrder();
    const before = await order(id);
    expect((await post(sup, supplierOrderId, "wrong")).status).toBe(401);
    expect((await post(sup, supplierOrderId, null)).status).toBe(401);
    await h.settle();
    // Nothing moved: no check was asked for, the order waits as it was.
    expect(await order(id)).toEqual(before);
  });

  it("answer ok for an order the store does not have, and change nothing", async () => {
    checks = [];
    const r = await post(sup, `WH-unknown-${run}`);
    expect(r).toEqual({ status: 200, data: { ok: true } });
    await h.settle();
    expect(checks).toEqual([]);
  });

  it("deliver an order once the supplier, asked again, says it is delivered (whatever the body said)", async () => {
    const { id, supplierOrderId } = await placeOrder();
    truth.set(supplierOrderId, { status: "delivered", supplierOrderId, items: [{ kind: "code", value: `HOOK-${run}` }] });
    checks = [];
    expect((await post(sup, supplierOrderId)).status).toBe(200);
    await h.settle();
    expect(checks).toEqual([supplierOrderId]);
    expect(await order(id)).toMatchObject({ status: "delivered", next_check_at: null });
    const view = await h.call("GET", `/api/orders/${id}`, { token });
    expect(view.data.deliveries.map((d: { value: string }) => d.value)).toEqual([`HOOK-${run}`]);
    // A second call for a closed order does nothing.
    checks = [];
    expect((await post(sup, supplierOrderId)).status).toBe(200);
    await h.settle();
    expect(checks).toEqual([]);
  });

  it("leave a still-pending order processing", async () => {
    const { id, supplierOrderId } = await placeOrder();
    checks = [];
    expect((await post(sup, supplierOrderId)).status).toBe(200);
    await h.settle();
    expect(checks).toEqual([supplierOrderId]);
    expect((await order(id)).status).toBe("processing");
  });

  it("on a failure: keep the order for the owner, or refund it when the owner chose that", async () => {
    const kept = await placeOrder();
    truth.set(kept.supplierOrderId, { status: "failed", supplierOrderId: kept.supplierOrderId, reason: "out of stock" });
    await post(sup, kept.supplierOrderId);
    await h.settle();
    expect(await order(kept.id)).toMatchObject({ status: "processing", hold: "owner" });
    // "Out of stock": the package shows as sold out until the price check sees stock again.
    expect((await db.query<{ paused_reason: string | null }>(`select paused_reason from app.offers where id = $1`, [offerId]))[0]!.paused_reason).toBe("supplier_unavailable");
    await db.query(`update app.offers set paused_reason = null where id = $1`, [offerId]);

    await db.query(`insert into app.settings (key, value) values ('orders.failed_to_owner', 'false') on conflict (key) do update set value = excluded.value`);
    const refunded = await placeOrder();
    truth.set(refunded.supplierOrderId, { status: "failed", supplierOrderId: refunded.supplierOrderId, reason: "out of stock" });
    const balance = async () => (await h.call("GET", "/api/me", { token })).data.balanceCents as number;
    const before = await balance();
    await post(sup, refunded.supplierOrderId);
    await h.settle();
    expect((await order(refunded.id)).status).toBe("refunded");
    expect(await balance()).toBe(before + 150);
  });
});
