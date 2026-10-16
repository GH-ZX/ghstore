/**
 * Favourites, "tell me when it's back", the owner's top-up limits, and the
 * admin top-ups list (counts and the USDT amount asked).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaymentAdapter, PaymentEvent, SupplierAdapter, SupplierProduct } from "@store/core";
import { syncSupplier } from "../src/index";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);

const sam: PaymentAdapter = {
  id: "sam",
  createPayment: async (input) => ({ providerRef: `SAM-${input.paymentId}`, action: { type: "redirect", url: "https://sam.example/pay" } }),
  checkPayment: async (ref): Promise<PaymentEvent> => ({ providerRef: ref, status: "pending" }),
};

let owner = "";
let customer = "";
let product = "";
let slug = "";
/** Sold from the store's own stock, with none left. */
let stockOffer = "";
/** A supplier's package the supplier has none of. */
let supplierOffer = "";
/** On sale. */
let liveOffer = "";
const sup = `fsup_${run}`;
/** What the fake supplier has in stock now. */
let supplierItems: SupplierProduct[] = [];
const supplier: SupplierAdapter = {
  id: sup,
  name: "Fav Supplier",
  listProducts: async () => supplierItems,
  getBalance: async () => null,
  purchase: async (req) => ({ status: "delivered", supplierOrderId: `F-${req.idempotencyKey}`, items: [{ kind: "code", value: "C" }] }),
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

beforeAll(async () => {
  h.payments.set("sam", sam);
  h.suppliers.set(sup, supplier);
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, 'Fav Supplier', true, null)`, [sup]);
  const cat = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  slug = `fav-${run}`;
  product = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, $2, 'مفضل', 'Fav Game', 'code', true) returning id`,
    [slug, cat],
  ))[0]!.id;
  const offer = async (name: string, supplier: string | null, paused: string | null, sort: number) =>
    (await db.query<{ id: string }>(
      `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, paused_reason, sort)
       values ($1, $2, $2, $3, $4, 100, 120, $5, $6) returning id`,
      [product, name, supplier, supplier ? `ref-${name}` : null, paused, sort],
    ))[0]!.id;
  liveOffer = await offer("Live", sup, null, 1);
  supplierOffer = await offer("Gone", sup, "supplier_unavailable", 0);
  stockOffer = await offer("Codes", null, null, 2);
  owner = await h.login(900001, "Owner");
  customer = await h.login(880_000_000 + (Date.now() % 1_000_000), "Fan");
});

afterAll(async () => {
  await db.query(`delete from app.settings where key in ('payments.min_topup_cents', 'payments.max_topup_cents')`);
  await conn.close();
});

describe("sold-out packages and 'notify me'", () => {
  it("lists sold-out packages last, flagged, instead of hiding them", async () => {
    const r = await h.call("GET", `/api/products/${slug}`);
    expect(r.status).toBe(200);
    expect(r.data.offers.map((o: { id: string; soldOut: boolean }) => [o.id, o.soldOut])).toEqual([
      [liveOffer, false],
      [supplierOffer, true],
      [stockOffer, true],
    ]);
  });

  it("takes a request only for a sold-out package, and tells the customer once when it is back", async () => {
    expect((await h.call("PUT", `/api/stock-alerts/${liveOffer}`, { token: customer })).status).toBe(409);
    expect((await h.call("PUT", `/api/stock-alerts/${stockOffer}`)).status).toBe(401);
    expect((await h.call("PUT", `/api/stock-alerts/${stockOffer}`, { token: customer })).status).toBe(200);
    expect((await h.call("PUT", `/api/stock-alerts/${supplierOffer}`, { token: customer })).status).toBe(200);
    expect((await h.call("GET", "/api/favorites", { token: customer })).data.offerIds.sort()).toEqual([stockOffer, supplierOffer].sort());

    const messages = async () =>
      db.query<{ data: { slug: string; offer_en: string } }>(
        `select o.data from app.outbox o join app.identities i on i.user_id = o.user_id
          where o.template = 'back_in_stock' and o.data->>'slug' = $1 order by o.id`,
        [slug],
      );
    // The owner adds codes: the stock package is back.
    expect((await h.call("POST", `/api/admin/offers/${stockOffer}/stock`, { token: owner, body: { items: ["CODE-1"] } })).status).toBe(201);
    expect((await messages()).map((m) => m.data.offer_en)).toEqual(["Codes"]);
    // The owner lifts the supplier pause: that one too, and each request is done.
    expect((await h.call("PATCH", `/api/admin/offers/${supplierOffer}`, { token: owner, body: { clearPause: true } })).status).toBe(200);
    expect((await messages()).map((m) => m.data.offer_en)).toEqual(["Codes", "Gone"]);
    expect((await h.call("GET", "/api/favorites", { token: customer })).data.offerIds).toEqual([]);
    // Nothing more to send the second time.
    await h.call("POST", `/api/admin/offers/${stockOffer}/stock`, { token: owner, body: { items: ["CODE-2"] } });
    expect((await messages()).length).toBe(2);

    // The price check finds the supplier has it again: the same message, by itself.
    await db.query(`update app.offers set paused_reason = 'supplier_unavailable' where id = $1`, [supplierOffer]);
    expect((await h.call("PUT", `/api/stock-alerts/${supplierOffer}`, { token: customer })).status).toBe(200);
    supplierItems = [
      { externalId: "ref-Live", name: "Live", costCents: 100, available: true, kind: "code" },
      { externalId: "ref-Gone", name: "Gone", costCents: 100, available: true, kind: "code" },
    ];
    const report = await syncSupplier(h.svc, sup);
    expect(report.resumed).toBe(1);
    expect((await messages()).map((m) => m.data.offer_en)).toEqual(["Codes", "Gone", "Gone"]);
  });
});

describe("favourites", () => {
  it("saves, lists and forgets products for signed-in customers", async () => {
    expect((await h.call("PUT", `/api/favorites/${product}`)).status).toBe(401);
    expect((await h.call("PUT", `/api/favorites/${product}`, { token: customer })).status).toBe(200);
    expect((await h.call("PUT", `/api/favorites/${product}`, { token: customer })).status).toBe(200); // twice is fine
    expect((await h.call("PUT", `/api/favorites/00000000-0000-7000-8000-00000000dead`, { token: customer })).status).toBe(404);
    const list = await h.call("GET", "/api/favorites", { token: customer });
    expect(list.data.productIds).toEqual([product]);
    expect(list.data.products[0]).toMatchObject({ slug, nameEn: "Fav Game" });
    expect(list.data.products[0].fromCents).toBeGreaterThan(0); // the cheapest package on sale
    expect((await h.call("DELETE", `/api/favorites/${product}`, { token: customer })).status).toBe(200);
    expect((await h.call("GET", "/api/favorites", { token: customer })).data.productIds).toEqual([]);
  });
});

describe("top-up limits (Admin → Settings → Top-ups)", () => {
  it("are the owner's to set, and every top-up follows them", async () => {
    expect((await h.call("PUT", "/api/admin/settings/payments.min_topup_cents", { token: owner, body: { value: 5 } })).status).toBe(400);
    expect((await h.call("PUT", "/api/admin/settings/payments.min_topup_cents", { token: owner, body: { value: 500 } })).status).toBe(200);
    expect((await h.call("PUT", "/api/admin/settings/payments.max_topup_cents", { token: owner, body: { value: 2000 } })).status).toBe(200);
    const config = await h.call("GET", "/api/config");
    expect(config.data.payments).toMatchObject({ minCents: 500, maxCents: 2000 });
    expect((await h.call("POST", "/api/topups", { token: customer, body: { method: "sam", amountCents: 300 } })).status).toBe(400);
    expect((await h.call("POST", "/api/topups", { token: customer, body: { method: "sam", amountCents: 2500 } })).status).toBe(400);
    expect((await h.call("POST", "/api/topups", { token: customer, body: { method: "sam", amountCents: 600 } })).status).toBe(201);
  });
});

describe("admin top-ups", () => {
  it("counts each list and shows the exact USDT amount asked", async () => {
    const me = await h.call("GET", "/api/me", { token: customer });
    await db.query(
      `insert into app.payments (user_id, method, amount_cents, status, send_units, action)
       values ($1, 'bep20', 200, 'review', $2, '{"type":"address","amount":"2.0137"}'::jsonb)`,
      [me.data.user.id, 20_000 + (Date.now() % 9_000) + 137 * 10],
    );
    const r = await h.call("GET", "/api/admin/payments?status=review", { token: owner });
    expect(r.status).toBe(200);
    expect(r.data.counts.review).toBeGreaterThanOrEqual(1);
    expect(r.data.payments.find((p: { send_amount: string | null }) => p.send_amount === "2.0137")).toBeTruthy();
  });
});
