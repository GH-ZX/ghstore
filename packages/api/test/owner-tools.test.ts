/**
 * The owner's tools: sales made in person (no wallet), product badges,
 * provider accounts (Admin → Settings → APIs) and the test email.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountInfo, PurchaseRequest, SupplierAdapter } from "@store/core";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const sup = `osup_${run}`;

const bought: PurchaseRequest[] = [];
const supplier: SupplierAdapter = {
  id: sup,
  name: "Codes",
  listProducts: async () => [],
  getBalance: async () => ({ amountCents: 1234, currency: "USD" }),
  purchase: async (req) => {
    bought.push(req);
    return { status: "delivered", supplierOrderId: `S-${req.idempotencyKey}`, items: [{ kind: "code", value: "GIFT-1" }] };
  },
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
  accountInfo: async (): Promise<AccountInfo> => ({
    fields: [{ label: "Name", value: "GH Store" }],
    balances: [{ currency: "USD", amount: 12.34 }],
    history: [{ at: "2026-10-16T10:00:00Z", amount: -1.5, currency: "USD", text: "Order 77", direction: "out" }],
  }),
};

let owner = "";
let customer = "";
let offer = "";
let slug = "";

beforeAll(async () => {
  h.suppliers.set(sup, supplier);
  Object.assign(env, { [`${sup.toUpperCase()}_API_KEY`]: "test-key" });
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, 'Codes', true, null)`, [sup]);
  const cat = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  slug = `gift-${run}`;
  const p = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, $2, 'x', 'Gift', 'code', true) returning id`,
    [slug, cat],
  ))[0]!.id;
  offer = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'x', '$10', $2, 'g10', 900, 1000) returning id`,
    [p, sup],
  ))[0]!.id;
  owner = await h.login(900001, "Owner");
  customer = await h.login(850_000_000 + (Date.now() % 1_000_000), "Buyer");
});

afterAll(async () => {
  await conn.close();
});

describe("sales made in person", () => {
  it("lets the owner sell without any balance; the supplier delivers as usual", async () => {
    const before = (await h.call("GET", "/api/wallet", { token: owner })).data.balanceCents;
    const r = await h.call("POST", "/api/admin/orders/in-person", { token: owner, body: { offerId: offer, idempotencyKey: `inp-${run}` } });
    expect(r.status).toBe(201);
    await h.settle();
    expect(bought).toHaveLength(1);
    const o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token: owner });
    expect(o.data.order).toMatchObject({ status: "delivered", totalCents: 1000 });
    expect(o.data.deliveries.map((d: { value: string }) => d.value)).toEqual(["GIFT-1"]);
    expect((await h.call("GET", "/api/wallet", { token: owner })).data.balanceCents).toBe(before);
    const row = (await db.query<{ paid_with: string; channel: string }>(`select paid_with, channel from app.orders where id = $1`, [r.data.orderId]))[0]!;
    expect(row).toEqual({ paid_with: "in_person", channel: "admin" });
    // The same key again: the same order, nothing bought twice.
    const again = await h.call("POST", "/api/admin/orders/in-person", { token: owner, body: { offerId: offer, idempotencyKey: `inp-${run}` } });
    expect(again.data).toMatchObject({ orderId: r.data.orderId, created: false });
  });

  it("is for the owner only, and its refund gives nothing back to a wallet", async () => {
    expect((await h.call("POST", "/api/admin/orders/in-person", { token: customer, body: { offerId: offer, idempotencyKey: `inp2-${run}` } })).status).toBe(403);
    // An in-person order the supplier could not deliver is refunded without a wallet credit.
    const p = await db.query<{ order_id: string }>(`select order_id from app.place_in_person_order(
      (select user_id from app.identities where provider = 'telegram' and subject = '900001'), $1, 1, '{}'::jsonb, $2)`, [offer, `inp3-${run}`]);
    const id = p[0]!.order_id;
    const before = (await h.call("GET", "/api/wallet", { token: owner })).data.balanceCents;
    const refund = await h.call("POST", `/api/admin/orders/${id}/refund`, { token: owner, body: { note: "customer changed their mind" } });
    expect(refund.data, JSON.stringify(refund.data)).toMatchObject({ refunded: true });
    expect((await h.call("GET", "/api/wallet", { token: owner })).data.balanceCents).toBe(before);
    expect((await db.query<{ status: string }>(`select status from app.orders where id = $1`, [id]))[0]!.status).toBe("refunded");
  });
});

describe("product badges", () => {
  it("shows the badge the owner chose, none, or the automatic one", async () => {
    const card = async () => (await h.call("GET", "/api/catalog")).data.products.find((p: { slug: string }) => p.slug === slug);
    const id = (await db.query<{ id: string }>(`select id from app.products where slug = $1`, [slug]))[0]!.id;
    expect((await h.call("PATCH", `/api/admin/products/${id}`, { token: owner, body: { badge: "none" } })).status).toBe(200);
    expect((await card()).badge).toBeNull();
    expect((await h.call("PATCH", `/api/admin/products/${id}`, { token: owner, body: { badge: "hot" } })).status).toBe(200);
    expect((await card()).badge).toBe("hot");
    expect((await h.call("PATCH", `/api/admin/products/${id}`, { token: owner, body: { badge: "free" } })).status).toBe(400);
    // Back to automatic: a product this new is one of the newest (other test files may add newer ones).
    await h.call("PATCH", `/api/admin/products/${id}`, { token: owner, body: { badge: null } });
    expect(["new", "best", null]).toContain((await card()).badge);
  });
});

describe("provider accounts", () => {
  it("lists the providers and shows one account to the owner", async () => {
    const list = await h.call("GET", "/api/admin/accounts", { token: owner });
    expect(list.data.accounts.find((a: { id: string }) => a.id === sup)).toMatchObject({ kind: "supplier", configured: true, readable: true });
    const one = await h.call("GET", `/api/admin/accounts/supplier/${sup}`, { token: owner });
    expect(one.data.info.balances).toEqual([{ currency: "USD", amount: 12.34 }]);
    expect(one.data.info.history[0].text).toBe("Order 77");
    expect((await h.call("GET", `/api/admin/accounts/supplier/${sup}`, { token: customer })).status).toBe(403);
    expect((await h.call("GET", "/api/admin/accounts/other/x", { token: owner })).status).toBe(404);
  });
});

describe("test email", () => {
  it("sends to a typed address when the owner has no email of their own", async () => {
    Object.assign(env, { RESEND_API_KEY: "re_test_key_0123456789" });
    await db.query(
      `insert into app.settings (key, value) values ('email.from', '"GH Store <orders@store.test>"'::jsonb) on conflict (key) do update set value = excluded.value`,
    );
    const sent: string[] = [];
    h.fetchImpl = async (input, init) => {
      if (String(input) === "https://api.resend.com/emails") {
        sent.push((JSON.parse(String(init?.body)) as { to: string[] }).to[0]!);
        return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };
    try {
      const none = await h.call("POST", "/api/admin/email/test", { token: owner, body: {} });
      expect(none.data.error).toMatchObject({ code: "bad_state", field: "email.to" });
      expect((await h.call("POST", "/api/admin/email/test", { token: owner, body: { to: "not an email" } })).status).toBe(400);
      const ok = await h.call("POST", "/api/admin/email/test", { token: owner, body: { to: "me@store.test" } });
      expect(ok.data).toMatchObject({ ok: true, to: "me@store.test" });
      expect(sent).toEqual(["me@store.test"]);
    } finally {
      delete (env as Record<string, unknown>).RESEND_API_KEY;
      await db.query(`delete from app.settings where key = 'email.from'`);
      h.fetchImpl = async () => new Response("not mocked", { status: 500 });
    }
  });
});
