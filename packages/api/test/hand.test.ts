/**
 * Products delivered by hand, details given after paying, supplier deliveries
 * checked before release, and clean names for suppliers that write shorthand.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PurchaseRequest, PurchaseResult, SupplierAdapter, SupplierProduct } from "@store/core";
import { eraseOldDetails } from "../src/jobs";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const sup = `hsup_${run}`;
const shorthand = `hbs_${run}`;

const purchases: PurchaseRequest[] = [];
let result: PurchaseResult = { status: "delivered", supplierOrderId: "S-1", items: [{ kind: "account", value: "user@x.test:pa55" }] };
const supplier: SupplierAdapter = {
  id: sup,
  name: "Accounts",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async (req) => {
    purchases.push(req);
    return result;
  },
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

// A supplier that names its items in shorthand, like BatStore.
const shorthandItems: SupplierProduct[] = [
  { externalId: "71", name: "Zoom - 3 months (100 people)", costCents: 793, available: true, kind: "account" },
  { externalId: "72", name: "Zoom - 12 months (100 people)", costCents: 2608, available: true, kind: "account" },
  { externalId: "73", name: "Capcut pro 1M 1600 Ai credit FW", costCents: 169, available: true, kind: "account" },
  { externalId: "74", name: "Chatgpt plus 1M (Google pay)Gmail NW", costCents: 680, available: false, kind: "account" },
];
const shorthandSupplier: SupplierAdapter = {
  id: shorthand,
  name: "Shorthand",
  listProducts: async () => shorthandItems,
  getBalance: async () => null,
  purchase: async () => ({ status: "failed", retryable: false, reason: "not used" }),
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

let owner = "";
let customer = "";
let other = "";
let manualProduct = "";
let manualOffer = "";
let reviewOffer = "";
let askFirstOffer = "";

const AFTER = [
  { type: "email" },
  { type: "password" },
  { type: "token", labelEn: "ChatGPT session token", hintEn: "chatgpt.com/api/auth/session, copy everything" },
];

async function fund(token: string, cents: number) {
  const me = await h.call("GET", "/api/me", { token });
  const p = await db.query<{ id: string }>(`insert into app.payments (user_id, method, amount_cents, status) values ($1, 'sam', $2, 'pending') returning id`, [me.data.user.id, cents]);
  await db.query(`select * from app.credit_payment($1, $2, $3)`, [p[0]!.id, cents, `hand-${p[0]!.id}`]);
}
const order = (offerId: string, key: string, token = customer) => h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `${key}-${run}` } });

beforeAll(async () => {
  h.suppliers.set(sup, supplier);
  h.suppliers.set(shorthand, shorthandSupplier);
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, 'Accounts', true, null)`, [sup]);
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct, clean_names) values ($1, 'Shorthand', true, null, true)`, [shorthand]);
  await db.query(`delete from app.identities where provider = 'telegram' and subject = '900001'`);
  owner = await h.login(900001, "Owner");
  customer = await h.login(840_000_000 + (Date.now() % 1_000_000), "Buyer");
  other = await h.login(841_000_000 + (Date.now() % 1_000_000), "Other");
  await fund(customer, 5000);
  await fund(other, 1000);

  const cat = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  // Sold by hand: ChatGPT Plus on the customer's own account.
  const made = await h.call("POST", "/api/admin/products", {
    token: owner,
    body: { slug: `chatgpt-${run}`, categoryId: cat, nameAr: "ChatGPT Plus", nameEn: "ChatGPT Plus", kind: "account", active: true, delivery: "manual", afterFields: AFTER },
  });
  expect(made.status).toBe(201);
  manualProduct = made.data.id;
  const offer = await h.call("POST", `/api/admin/products/${manualProduct}/offers`, {
    token: owner,
    body: { nameAr: "شهر واحد", nameEn: "1 month", markupMode: "manual", priceCents: 1200, costCents: 900, warrantyEn: "Full warranty", warrantyAr: "ضمان كامل" },
  });
  expect(offer.status).toBe(201);
  manualOffer = offer.data.id;

  // A supplier's product checked before release.
  const review = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active, delivery) values ($1, $2, 'x', 'Reviewed', 'account', true, 'review') returning id`,
    [`reviewed-${run}`, cat],
  ))[0]!.id;
  reviewOffer = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'x', 'Year', $2, 'acc-1', 100, 150) returning id`,
    [review, sup],
  ))[0]!.id;

  // A supplier's product that needs the customer's details before it is bought.
  const askFirst = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active, after_fields) values ($1, $2, 'x', 'Activated', 'account', true, $3::text::jsonb) returning id`,
    [`activated-${run}`, cat, JSON.stringify([{ key: "email", type: "email", labelEn: "Email", labelAr: "البريد", required: true }])],
  ))[0]!.id;
  askFirstOffer = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'x', 'Month', $2, 'act-1', 100, 150) returning id`,
    [askFirst, sup],
  ))[0]!.id;
});

afterAll(async () => {
  await conn.close();
});

describe("products delivered by hand", () => {
  let orderId = "";

  it("shows what will be asked after paying, and the package's warranty", async () => {
    const p = await h.call("GET", `/api/products/chatgpt-${run}`);
    expect(p.data.product.byHand).toBe(true);
    expect(p.data.product.afterFields.map((f: { key: string; labelEn: string }) => `${f.key}:${f.labelEn}`)).toEqual([
      "email:Email", "password:Password", "token:ChatGPT session token",
    ]);
    expect(p.data.offers[0]).toMatchObject({ warrantyEn: "Full warranty", warrantyAr: "ضمان كامل" });
  });

  it("takes the payment, then waits for the customer's details", async () => {
    const r = await order(manualOffer, "hand-1");
    expect(r.status).toBe(201);
    orderId = r.data.orderId;
    await h.settle();
    expect(purchases).toHaveLength(0);
    const o = await h.call("GET", `/api/orders/${orderId}`, { token: customer });
    expect(o.data.order).toMatchObject({ status: "paid", hold: "info", canAnswer: true });
    const reminder = await db.query(`select 1 from app.outbox where template = 'order_needs_info' and data->>'order_id' = $1`, [orderId]);
    expect(reminder).toHaveLength(1);
  });

  it("checks the details, keeps them encrypted and tells the team", async () => {
    const send = (values: Record<string, string>, token = customer) => h.call("POST", `/api/orders/${orderId}/answers`, { token, body: { values } });
    expect((await send({ email: "not-an-email", password: "x", token: "t" })).status).toBe(400);
    expect((await send({ email: "me@mail.test", password: "secret-1" })).status).toBe(400); // the token is required
    expect((await send({ email: "me@mail.test", password: "secret-1", token: "eyJ.session" }, other)).status).toBe(404);
    expect((await send({ email: "me@mail.test", password: "secret-1", token: "eyJ.session\nline2" })).status).toBe(200);

    const row = (await db.query<{ hold: string; answers_enc: string }>(`select hold, answers_enc from app.orders where id = $1`, [orderId]))[0]!;
    expect(row.hold).toBe("owner");
    expect(row.answers_enc).not.toContain("secret-1");
    const alerts = await db.query<{ data: { text: string } }>(`select data from app.outbox where template = 'staff_alert' and data->>'text' like $1`, [`%(ChatGPT Plus) has the customer's details%`]);
    expect(alerts.length).toBeGreaterThan(0);
    expect(JSON.stringify(alerts)).not.toContain("secret-1");

    // The customer sees what they gave, without the secrets.
    const o = await h.call("GET", `/api/orders/${orderId}`, { token: customer });
    expect(o.data.order.afterFields.map((f: { value: string | null; given: boolean }) => [f.value, f.given])).toEqual([["me@mail.test", true], [null, true], [null, true]]);
    // A correction can leave the secrets empty to keep them.
    expect((await send({ email: "fixed@mail.test", password: "", token: "" })).status).toBe(200);
  });

  it("lists it as waiting, shows the details to staff (logged), and delivers it", async () => {
    const list = await h.call("GET", "/api/admin/orders?status=waiting", { token: owner });
    expect(list.data.waiting).toBeGreaterThan(0);
    expect(list.data.orders.some((o: { id: string; hold: string }) => o.id === orderId && o.hold === "owner")).toBe(true);

    const detail = await h.call("GET", `/api/admin/orders/${orderId}`, { token: owner });
    expect(detail.data.order.details.map((d: { value: string }) => d.value)).toEqual(["fixed@mail.test", "secret-1", "eyJ.session\nline2"]);
    expect((await db.query(`select 1 from app.audit_log where action = 'order.details_view' and target_id = $1`, [orderId])).length).toBeGreaterThan(0);
    expect((await h.call("GET", `/api/admin/orders/${orderId}`, { token: customer })).status).toBe(403);
    // Monitors watch the list but never see the details or deliver.
    const monitor = await h.login(842_000_000 + (Date.now() % 1_000_000), "Monitor");
    const me = await h.call("GET", "/api/me", { token: monitor });
    await db.query(`update app.users set role = 'monitor' where id = $1`, [me.data.user.id]);
    expect((await h.call("GET", "/api/admin/orders?status=waiting", { token: monitor })).status).toBe(200);
    expect((await h.call("GET", `/api/admin/orders/${orderId}`, { token: monitor })).status).toBe(403);
    expect((await h.call("POST", `/api/admin/orders/${orderId}/deliver`, { token: monitor, body: { items: [{ value: "x" }] } })).status).toBe(403);

    expect((await h.call("POST", `/api/admin/orders/${orderId}/deliver`, { token: owner, body: { items: [] } })).status).toBe(400);
    const d = await h.call("POST", `/api/admin/orders/${orderId}/deliver`, {
      token: owner,
      body: { items: [{ kind: "account", label: "Login", value: "Activated on fixed@mail.test" }] },
    });
    expect(d.status).toBe(200);
    const o = await h.call("GET", `/api/orders/${orderId}`, { token: customer });
    expect(o.data.order).toMatchObject({ status: "delivered", hold: null, canAnswer: false });
    expect(o.data.deliveries).toEqual([{ kind: "account", label: "Login", value: "Activated on fixed@mail.test" }]);
    expect((await h.call("POST", `/api/orders/${orderId}/answers`, { token: customer, body: { values: {} } })).status).toBe(409);
    expect((await h.call("POST", `/api/admin/orders/${orderId}/deliver`, { token: owner, body: { items: [{ value: "again" }] } })).status).toBe(409);
  });

  it("erases the details two weeks after the order is closed", async () => {
    await db.query(`update app.orders set delivered_at = now() - interval '15 days' where id = $1`, [orderId]);
    expect(await eraseOldDetails(h.svc)).toBeGreaterThanOrEqual(1);
    expect((await db.query<{ answers_enc: string | null }>(`select answers_enc from app.orders where id = $1`, [orderId]))[0]!.answers_enc).toBeNull();
  });

  it("can be refunded instead", async () => {
    const r = await order(manualOffer, "hand-2");
    const refund = await h.call("POST", `/api/admin/orders/${r.data.orderId}/refund`, { token: owner, body: { note: "no stock today" } });
    expect(refund.data.refunded).toBe(true);
  });
});

describe("a supplier's delivery checked before release", () => {
  it("buys at once, hides what the supplier sent until a person releases it", async () => {
    purchases.length = 0;
    result = { status: "delivered", supplierOrderId: "S-R1", items: [{ kind: "account", value: "supplier:acc" }] };
    const r = await order(reviewOffer, "review-1");
    await h.settle();
    expect(purchases).toHaveLength(1);
    let o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token: customer });
    expect(o.data.order).toMatchObject({ status: "processing", hold: "release" });
    expect(o.data.deliveries).toEqual([]);

    const detail = await h.call("GET", `/api/admin/orders/${r.data.orderId}`, { token: owner });
    expect(detail.data.deliveries.map((d: { value: string }) => d.value)).toEqual(["supplier:acc"]);
    expect((await h.call("POST", `/api/admin/orders/${r.data.orderId}/deliver`, { token: owner, body: {} })).status).toBe(200);
    o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token: customer });
    expect(o.data.order.status).toBe("delivered");
    expect(o.data.deliveries.map((d: { value: string }) => d.value)).toEqual(["supplier:acc"]);
  });
});

describe("a supplier's product that needs details first", () => {
  it("buys only once the customer has given them", async () => {
    purchases.length = 0;
    result = { status: "delivered", supplierOrderId: "S-A1", items: [{ kind: "code", value: "ACT-1" }] };
    const r = await order(askFirstOffer, "ask-1");
    await h.settle();
    expect(purchases).toHaveLength(0);
    expect((await h.call("GET", `/api/orders/${r.data.orderId}`, { token: customer })).data.order.hold).toBe("info");
    expect((await h.call("POST", `/api/orders/${r.data.orderId}/answers`, { token: customer, body: { values: { email: "me@mail.test" } } })).status).toBe(200);
    await h.settle();
    expect(purchases).toHaveLength(1);
    const o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token: customer });
    expect(o.data.order.status).toBe("delivered");
  });
});

describe("clean names for suppliers that write shorthand", () => {
  it("names and groups the items, and new packages carry their warranty", async () => {
    const frame = await h.call("GET", `/api/admin/suppliers/${shorthand}/catalogue`, { token: owner });
    expect(frame.status).toBe(200);
    const groups = frame.data.groups.map((g: { id: string; name: string; total: number }) => `${g.name}:${g.total}`).sort();
    expect(groups).toEqual(["CapCut Pro:1", "ChatGPT Plus:1", "Zoom:2"]);

    const zoom = frame.data.groups.find((g: { name: string }) => g.name === "Zoom");
    const items = await h.call("GET", `/api/admin/suppliers/${shorthand}/catalogue/items?group=${encodeURIComponent(zoom.id)}`, { token: owner });
    expect(items.data.items.map((i: { packageName: string }) => i.packageName)).toEqual(["3 months · 100 participants", "12 months · 100 participants"]);

    const applied = await h.call("POST", `/api/admin/suppliers/${shorthand}/selection`, { token: owner, body: { version: frame.data.version, add: ["71", "72", "73"] } });
    expect(applied.status).toBe(200);
    expect(applied.data.counts).toMatchObject({ added: 3, productsCreated: 2 });
    const offers = await db.query<{ product: string; name_en: string; name_ar: string; warranty_en: string | null }>(
      `select p.name_en as product, o.name_en, o.name_ar, o.warranty_en from app.offers o join app.products p on p.id = o.product_id
        where o.supplier_id = $1 order by o.supplier_ref`,
      [shorthand],
    );
    expect(offers).toEqual([
      { product: "Zoom", name_en: "3 months · 100 participants", name_ar: "3 أشهر · 100 مشارك", warranty_en: null },
      { product: "Zoom", name_en: "12 months · 100 participants", name_ar: "12 شهراً · 100 مشارك", warranty_en: null },
      { product: "CapCut Pro", name_en: "1 month · 1,600 AI credits", name_ar: "شهر واحد · 1,600 رصيد AI", warranty_en: "Full warranty" },
    ]);
  });

  it("previews and saves the owner's words, renaming the saved list only", async () => {
    const names = await h.call("GET", `/api/admin/names?supplier=${shorthand}`, { token: owner });
    expect(names.data.isDefault).toBe(true);
    const words = [...names.data.words.filter((w: { from: string }) => w.from !== "gmail"), { from: "gmail", en: "Gmail ready", ar: "جيميل جاهز", part: "package" }];
    const preview = await h.call("POST", "/api/admin/names/preview", { token: owner, body: { supplierId: shorthand, words } });
    const gpt = preview.data.items.find((i: { ref: string }) => i.ref === "74");
    expect(gpt.packageEn).toBe("1 month · Google Pay · Gmail ready");
    expect((await h.call("POST", "/api/admin/names/preview", { token: owner, body: { supplierId: shorthand, words: [{ from: "" }] } })).status).toBe(400);

    const saved = await h.call("PUT", "/api/admin/names", { token: owner, body: { words } });
    expect(saved.data.renamed).toBeGreaterThanOrEqual(1);
    const item = (await db.query<{ package_name: string }>(`select package_name from app.supplier_items where supplier_id = $1 and external_id = '74'`, [shorthand]))[0]!;
    expect(item.package_name).toBe("1 month · Google Pay · Gmail ready");
    // Back to the built-in words.
    expect((await h.call("PUT", "/api/admin/names", { token: owner, body: { words: null } })).status).toBe(200);
    expect((await h.call("GET", "/api/admin/names", { token: owner })).data.isDefault).toBe(true);
  });
});
