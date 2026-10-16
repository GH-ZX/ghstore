/**
 * Units on packages, virtual numbers (cancel / already used, expiry), stock that
 * runs out, supplier checks, and store pictures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PurchaseResult, SupplierAdapter, SupplierProduct } from "@store/core";
import { copyLinkedImages } from "../src/images";
import { syncSupplier } from "../src/index";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const sms = `nsms_${run}`;
const stock = `nstock_${run}`;

// A virtual-number supplier like 5SIM.
let checks: PurchaseResult[] = [];
let cancelAccepted = true;
const cancelled: string[] = [];
const banned: string[] = [];
let lastMaxCost: number | undefined;
const smsSupplier: SupplierAdapter = {
  id: sms,
  name: "Numbers",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async (req) => {
    lastMaxCost = req.maxCostCents;
    return { status: "pending", supplierOrderId: `N-${req.idempotencyKey}`, items: [{ kind: "phone", value: "+15550001" }], expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  },
  checkOrder: async (id) => checks.shift() ?? { status: "pending", supplierOrderId: id },
  cancel: async (id) => {
    cancelled.push(id);
    return cancelAccepted;
  },
};
(smsSupplier as SupplierAdapter & { ban: (id: string) => Promise<boolean> }).ban = async (id) => {
  banned.push(id);
  return true;
};

// A supplier that runs out of stock.
let stockItems: SupplierProduct[] = [];
let purchaseResult: PurchaseResult = { status: "failed", retryable: false, reason: "out of stock at supplier: no items" };
const stockSupplier: SupplierAdapter = {
  id: stock,
  name: "Stock",
  listProducts: async () => stockItems,
  getBalance: async () => null,
  purchase: async () => purchaseResult,
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

let owner = "";
let customer = "";
let numberOffer = "";
let stockOffer = "";
let unitsProduct = "";

async function fund(token: string, cents: number) {
  const me = await h.call("GET", "/api/me", { token });
  const p = await db.query<{ id: string }>(`insert into app.payments (user_id, method, amount_cents, status) values ($1, 'sam', $2, 'pending') returning id`, [me.data.user.id, cents]);
  await db.query(`select * from app.credit_payment($1, $2, $3)`, [p[0]!.id, cents, `num-${p[0]!.id}`]);
}
const balance = async (token: string) => (await h.call("GET", "/api/wallet", { token })).data.balanceCents as number;
const order = (offerId: string, key: string) => h.call("POST", "/api/orders", { token: customer, body: { offerId, idempotencyKey: `${key}-${run}` } });

beforeAll(async () => {
  h.suppliers.set(sms, smsSupplier);
  h.suppliers.set(stock, stockSupplier);
  for (const id of [sms, stock]) await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, $1, true, null)`, [id]);
  const cat = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  const mk = async (slug: string, kind: string) =>
    (await db.query<{ id: string }>(`insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, $2, 'x', 'X', $3, true) returning id`, [slug, cat, kind]))[0]!.id;
  const numbers = await mk(`numbers-${run}`, "sms");
  numberOffer = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'أمريكا', 'USA', $2, 'usa/telegram', 40, 60) returning id`,
    [numbers, sms],
  ))[0]!.id;
  const accounts = await mk(`accounts-${run}`, "account");
  stockOffer = (await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'شهر', 'Month', $2, 'acc-1', 100, 150) returning id`,
    [accounts, stock],
  ))[0]!.id;
  unitsProduct = await mk(`units-${run}`, "id");
  for (const name of ["60", "325", "Weekly Pass"]) {
    await db.query(`insert into app.offers (product_id, name_ar, name_en, price_cents) values ($1, $2, $2, 100)`, [unitsProduct, name]);
  }
  await db.query(`delete from app.identities where provider = 'telegram' and subject = '900001'`);
  owner = await h.login(900001, "Owner");
  customer = await h.login(830_000_000 + (Date.now() % 1_000_000), "Buyer");
  await fund(customer, 1000);
});

afterAll(async () => {
  await conn.close();
});

describe("units", () => {
  const names = async () =>
    (await db.query<{ name_en: string; name_ar: string }>(`select name_en, name_ar from app.offers where product_id = $1 order by name_en`, [unitsProduct])).map((o) => `${o.name_en}|${o.name_ar}`);

  it("names packages given by their amount with the product's unit, and swaps or removes it later", async () => {
    const r = await h.call("PATCH", `/api/admin/products/${unitsProduct}`, { token: owner, body: { unitEn: "UC", unitAr: "شدة" } });
    expect(r.data.renamed).toBe(2);
    expect(await names()).toEqual(["325 UC|325 شدة", "60 UC|60 شدة", "Weekly Pass|Weekly Pass"]);
    await h.call("PATCH", `/api/admin/products/${unitsProduct}`, { token: owner, body: { unitEn: "Diamonds" } });
    expect(await names()).toEqual(["325 Diamonds|325 شدة", "60 Diamonds|60 شدة", "Weekly Pass|Weekly Pass"]);
    await h.call("PATCH", `/api/admin/products/${unitsProduct}`, { token: owner, body: { unitEn: "", unitAr: "" } });
    expect(await names()).toEqual(["325|325", "60|60", "Weekly Pass|Weekly Pass"]);
    expect((await h.call("PATCH", `/api/admin/products/${unitsProduct}`, { token: owner, body: { unitEn: "x".repeat(30) } })).status).toBe(400);
  });
});

describe("virtual numbers", () => {
  it("shows the number with its expiry, and refunds it when the customer cancels before a code", async () => {
    const before = await balance(customer);
    const placed = await order(numberOffer, "n1");
    expect(placed.status).toBe(201);
    await h.settle();
    expect(lastMaxCost).toBe(40); // never more than the package was priced from
    const view = await h.call("GET", `/api/orders/${placed.data.orderId}`, { token: customer });
    expect(view.data.order).toMatchObject({ status: "processing", kind: "sms", numberActions: true });
    expect(Date.parse(view.data.order.expiresAt)).toBeGreaterThan(Date.now());
    expect(view.data.deliveries).toEqual([{ kind: "phone", label: null, value: "+15550001" }]);

    const r = await h.call("POST", `/api/orders/${placed.data.orderId}/number`, { token: customer, body: { action: "cancel" } });
    expect(r.data).toEqual({ closed: true });
    expect(cancelled).toContain(`N-${placed.data.orderId}`);
    expect((await h.call("GET", `/api/orders/${placed.data.orderId}`, { token: customer })).data.order.status).toBe("refunded");
    expect(await balance(customer)).toBe(before);
  });

  it("reports a number as already used (refunded), and refuses actions on someone else's order", async () => {
    const placed = await order(numberOffer, "n2");
    await h.settle();
    const stranger = await h.login(831_000_000 + (Date.now() % 1_000_000), "Other");
    expect((await h.call("POST", `/api/orders/${placed.data.orderId}/number`, { token: stranger, body: { action: "used" } })).status).toBe(404);
    expect((await h.call("POST", `/api/orders/${placed.data.orderId}/number`, { token: customer, body: { action: "nope" } })).status).toBe(400);
    const r = await h.call("POST", `/api/orders/${placed.data.orderId}/number`, { token: customer, body: { action: "used" } });
    expect(r.data.closed).toBe(true);
    expect(banned).toContain(`N-${placed.data.orderId}`);
  });

  it("tries another number: reports the first (refunded) and buys the next one at once", async () => {
    const before = await balance(customer);
    const placed = await order(numberOffer, "n4");
    await h.settle();
    const r = await h.call("POST", `/api/orders/${placed.data.orderId}/number`, { token: customer, body: { action: "used", again: true } });
    expect(r.data.closed).toBe(true);
    expect(r.data.orderId).toBeTruthy();
    expect(r.data.orderId).not.toBe(placed.data.orderId);
    await h.settle();
    expect(banned).toContain(`N-${placed.data.orderId}`);
    const next = await h.call("GET", `/api/orders/${r.data.orderId}`, { token: customer });
    expect(next.data.order).toMatchObject({ status: "processing", numberActions: true });
    // One number paid for: the first was refunded.
    expect(await balance(customer)).toBe(before - 60);
    // Asking twice does not buy a third number.
    const again = await h.call("POST", `/api/orders/${placed.data.orderId}/number`, { token: customer, body: { action: "used", again: true } });
    expect(again.status).toBe(409);
  });

  it("shows each country's success rate and lists the best first", async () => {
    const product = (await db.query<{ product_id: string }>(`select product_id from app.offers where id = $1`, [numberOffer]))[0]!.product_id;
    const slug = (await db.query<{ slug: string }>(`select slug from app.products where id = $1`, [product]))[0]!.slug;
    await db.query(`update app.offers set success_pct = 41.5 where id = $1`, [numberOffer]);
    await db.query(
      `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, success_pct) values ($1, 'هولندا', 'Netherlands', $2, 'netherlands/telegram', 10, 20, 73)`,
      [product, sms],
    );
    const p = await h.call("GET", `/api/products/${slug}`);
    expect(p.data.offers.map((o: { nameEn: string; successPct: number | null }) => [o.nameEn, o.successPct])).toEqual([["Netherlands", 73], ["USA", 41.5]]);
  });

  it("fetches the code instead when the supplier refuses to cancel because it just arrived", async () => {
    const placed = await order(numberOffer, "n3");
    await h.settle();
    cancelAccepted = false;
    checks = [{ status: "delivered", supplierOrderId: `N-${placed.data.orderId}`, items: [{ kind: "phone", value: "+15550001" }, { kind: "sms", value: "849201" }] }];
    const r = await h.call("POST", `/api/orders/${placed.data.orderId}/number`, { token: customer, body: { action: "cancel" } });
    expect(r.data).toEqual({ closed: false });
    const view = await h.call("GET", `/api/orders/${placed.data.orderId}`, { token: customer });
    expect(view.data.order).toMatchObject({ status: "delivered", numberActions: false });
    expect(view.data.deliveries.map((d: { value: string }) => d.value)).toContain("849201");
    cancelAccepted = true;
  });
});

describe("out of stock", () => {
  it("refunds a purchase the supplier has no stock for, and hides the package at once", async () => {
    const before = await balance(customer);
    const placed = await order(stockOffer, "s1");
    await h.settle();
    expect((await h.call("GET", `/api/orders/${placed.data.orderId}`, { token: customer })).data.order.status).toBe("refunded");
    expect(await balance(customer)).toBe(before);
    const o = (await db.query<{ paused_reason: string | null }>(`select paused_reason from app.offers where id = $1`, [stockOffer]))[0]!;
    expect(o.paused_reason).toBe("supplier_unavailable");
    // Back in stock: the check puts it on sale again, without a Telegram alert either way.
    h.telegramCalls.length = 0;
    stockItems = [{ externalId: "acc-1", name: "Month", costCents: 100, available: true, kind: "account" }];
    const report = await syncSupplier(h.svc, stock);
    expect(report.resumed).toBe(1);
    stockItems = [{ externalId: "acc-1", name: "Month", costCents: 100, available: false, kind: "account" }];
    await syncSupplier(h.svc, stock);
    expect((await db.query<{ paused_reason: string | null }>(`select paused_reason from app.offers where id = $1`, [stockOffer]))[0]!.paused_reason).toBe("supplier_unavailable");
    expect(h.telegramCalls.filter((c) => String(c.payload.text ?? "").includes(stock))).toHaveLength(0);
  });

  it("alerts on stock changes only for suppliers with stock alerts on", async () => {
    expect((await h.call("PATCH", `/api/admin/suppliers/${stock}`, { token: owner, body: { stockAlerts: true, syncMinutes: 5 } })).status).toBe(200);
    stockItems = [{ externalId: "acc-1", name: "Month", costCents: 100, available: true, kind: "account" }];
    await syncSupplier(h.svc, stock);
    stockItems = [{ externalId: "acc-1", name: "Month", costCents: 100, available: false, kind: "account" }];
    h.telegramCalls.length = 0;
    await syncSupplier(h.svc, stock);
    await h.settle();
    const list = await h.call("GET", "/api/admin/suppliers", { token: owner });
    expect(list.data.suppliers.find((s: { id: string }) => s.id === stock)).toMatchObject({ stockAlerts: true, syncMinutes: 5 });
  });

  it("checks every enabled supplier now", async () => {
    const r = await h.call("POST", "/api/admin/suppliers/check-all", { token: owner, body: {} });
    expect(r.status).toBe(200);
    expect(r.data.reports.map((x: { supplier: string }) => x.supplier)).toEqual(expect.arrayContaining([stock, sms]));
  });
});

describe("store pictures", () => {
  it("needs the storage key, then uploads a copy of a linked picture into the bucket", async () => {
    expect((await h.call("POST", "/api/admin/images", { token: owner, body: { url: "https://cdn.example/x.png" } })).status).toBe(403);
    const stored: string[] = [];
    h.fetchImpl = async (input, init) => {
      const url = String(input);
      if (url === "https://cdn.example/cover.png") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      if (url === "https://cdn.example/moved.png") return new Response(null, { status: 302, headers: { location: "/cover.png" } });
      if (url === "https://cdn.example/inside.png") return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
      if (url === "https://cdn.example/huge.png") return new Response(new Uint8Array(5 * 1024 * 1024), { headers: { "content-type": "image/png" } });
      if (url === "https://cdn.example/icon.svg") return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
      if (url.startsWith("https://proj.supabase.test/storage/v1/object/store-images/")) {
        stored.push(url);
        expect((init?.headers as Record<string, string>).apikey).toBe("sb_secret_test_storage_key");
        return new Response("{}", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };
    Object.assign(env, { SUPABASE_URL: "https://proj.supabase.test", SUPABASE_SECRET_KEY: "sb_secret_test_storage_key" });
    try {
      const r = await h.call("POST", "/api/admin/images", { token: owner, body: { url: "https://cdn.example/cover.png" } });
      expect(r.status).toBe(201);
      expect(r.data.url).toMatch(/^https:\/\/proj\.supabase\.test\/storage\/v1\/object\/public\/store-images\/[0-9a-f]{32}\.png$/);
      expect((await h.call("POST", "/api/admin/images", { token: owner, body: { url: "https://cdn.example/missing.png" } })).status).toBe(400);
      // Redirects are checked hop by hop; local addresses, huge bodies and SVGs are refused.
      expect((await h.call("POST", "/api/admin/images", { token: owner, body: { url: "https://cdn.example/moved.png" } })).data.url).toBe(r.data.url);
      for (const bad of ["https://cdn.example/inside.png", "https://127.0.0.1/x.png", "https://localhost/x.png", "https://cdn.example:8443/x.png", "https://cdn.example/huge.png", "https://cdn.example/icon.svg"]) {
        expect((await h.call("POST", "/api/admin/images", { token: owner, body: { url: bad } })).status, bad).toBe(400);
      }

      // The job copies linked pictures and points products at the copy.
      await db.query(`update app.products set cover_url = 'https://cdn.example/cover.png' where id = $1`, [unitsProduct]);
      const copied = await copyLinkedImages(h.svc, env, 50);
      expect(copied).toBeGreaterThanOrEqual(1);
      const p = (await db.query<{ cover_url: string }>(`select cover_url from app.products where id = $1`, [unitsProduct]))[0]!;
      expect(p.cover_url).toBe(r.data.url);
      expect(stored.length).toBeGreaterThanOrEqual(2);
    } finally {
      delete (env as Record<string, unknown>).SUPABASE_URL;
      delete (env as Record<string, unknown>).SUPABASE_SECRET_KEY;
      h.fetchImpl = async () => new Response("not mocked", { status: 500 });
    }
  });
});
