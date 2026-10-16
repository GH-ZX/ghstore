/**
 * Admin → Suppliers → Choose packages: the saved copy of a supplier's list and
 * applying a selection (add, remove, archive, stale screens, a second supplier).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupplierAdapter, SupplierProduct } from "@store/core";
import { refreshDueCatalogues, syncSupplier } from "../src/index";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const big = `cbig_${run}`; // a big catalogue listed a group at a time (like G2Bulk)
const flat = `cflat_${run}`; // a supplier that lists everything at once (like BatStore)

// The "big" supplier: games, each with its packages, grouped as one product per game.
let games: Record<string, SupplierProduct[]> = {};
const pkg = (game: string, name: string, cost: number, available = true): SupplierProduct => ({
  externalId: `${game}:${name}`, name: `${game} — ${name}`, costCents: cost, available, kind: "id",
  fields: [{ key: "player_id", labelEn: "Player ID", required: true }],
  productKey: `game:${game}`, productName: `Game ${game.toUpperCase()} ${run}`, packageName: name,
});
const listed: string[] = [];
const bigSupplier: SupplierAdapter = {
  id: big,
  name: "Big",
  listGroups: async () => Object.keys(games).map((g) => ({ id: `game:${g}`, name: `Game ${g}` })),
  listProducts: async (group) => {
    listed.push(group ?? "");
    return games[(group ?? "").slice(5)] ?? [];
  },
  listProductsFor: async (refs) => Object.values(games).flat().filter((p) => refs.includes(p.externalId)),
  syncGroup: (ref) => `game:${ref.split(":")[0]}`,
  getBalance: async () => null,
  purchase: async () => ({ status: "failed", retryable: false, reason: "test" }),
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

// The "flat" supplier: every item is a product of its own.
let flatItems: SupplierProduct[] = [];
const flatSupplier: SupplierAdapter = {
  id: flat,
  name: "Flat",
  listProducts: async () => flatItems,
  getBalance: async () => null,
  purchase: async () => ({ status: "failed", retryable: false, reason: "test" }),
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

let owner = "";
let customerId = "";
let gamesCategory = "";

beforeAll(async () => {
  h.suppliers.set(big, bigSupplier);
  h.suppliers.set(flat, flatSupplier);
  for (const [id, name] of [[big, "Big"], [flat, "Flat"]]) {
    await db.query(`insert into app.suppliers (id, name, enabled, import_markup_pct, import_round_to_cents, import_description_en, import_description_ar) values ($1, $2, true, 20, 1, 'Buy {name} here.', 'اشترِ {name} هنا.')`, [id, name]);
  }
  gamesCategory = (await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`))[0]!.id;
  await db.query(`update app.suppliers set import_category_id = $2 where id = $1`, [big, gamesCategory]);
  await db.query(`delete from app.identities where provider = 'telegram' and subject = '900001'`);
  owner = await h.login(900001, "Owner");
  const customer = await h.login(800_000_000 + (Date.now() % 100_000_000), "Buyer");
  customerId = (await h.call("GET", "/api/me", { token: customer })).data.user.id;
});

afterAll(async () => {
  await conn.close();
});

const catalogue = (s: string) => h.call("GET", `/api/admin/suppliers/${s}/catalogue`, { token: owner });
const items = (s: string, group: string) => h.call("GET", `/api/admin/suppliers/${s}/catalogue/items?group=${encodeURIComponent(group)}`, { token: owner });
const select = (s: string, body: Record<string, unknown>) => h.call("POST", `/api/admin/suppliers/${s}/selection`, { token: owner, body });
const offerOf = async (s: string, ref: string) =>
  (await db.query<{ id: string; active: boolean; product_id: string; price_cents: string; name_en: string }>(
    `select id, active, product_id, price_cents::text, name_en from app.offers where supplier_id = $1 and supplier_ref = $2`, [s, ref],
  ))[0];

describe("choose packages", () => {
  it("is for the owner only", async () => {
    const customer = await h.login(800_100_000 + (Date.now() % 100_000), "Nobody");
    expect((await h.call("GET", `/api/admin/suppliers/${big}/catalogue`, { token: customer })).status).toBe(403);
    expect((await h.call("POST", `/api/admin/suppliers/${big}/selection`, { token: customer, body: { version: 0, add: ["x"] } })).status).toBe(403);
  });

  it("lists a big catalogue's groups, then reads a group when it is opened", async () => {
    games = { pubg: [pkg("pubg", "60 UC", 89), pkg("pubg", "325 UC", 445), pkg("pubg", "8100 UC", 8900)], ff: [pkg("ff", "100 Diamonds", 95)] };
    const c = await catalogue(big);
    expect(c.status).toBe(200);
    expect(c.data.supplier.grouped).toBe(true);
    expect(c.data.groups.map((g: any) => g.id).sort()).toEqual(["game:ff", "game:pubg"]);
    expect(c.data.groups.find((g: any) => g.id === "game:pubg").total).toBeNull(); // not read yet
    expect(listed).toEqual([]);

    const pubg = await items(big, "game:pubg");
    expect(pubg.status).toBe(200);
    expect(listed).toEqual(["game:pubg"]);
    expect(pubg.data.items.map((i: any) => [i.packageName, i.costCents, i.offer])).toEqual([["60 UC", 89, null], ["325 UC", 445, null], ["8100 UC", 8900, null]]);
    // A fresh copy is not read again.
    await items(big, "game:pubg");
    expect(listed).toEqual(["game:pubg"]);
    expect((await catalogue(big)).data.groups.find((g: any) => g.id === "game:pubg")).toMatchObject({ total: 3, chosen: 0 });
  });

  it("previews, then adds packages: one new product per game, priced and described", async () => {
    const version = (await catalogue(big)).data.version;
    const body = { version, add: ["pubg:60 UC", "pubg:325 UC", "pubg:8100 UC"], dryRun: true };
    const dry = await select(big, body);
    expect(dry.status).toBe(200);
    expect(dry.data.plan.add).toHaveLength(1);
    expect(dry.data.plan.add[0]).toMatchObject({ isNew: true, categoryId: gamesCategory, nameEn: `Game PUBG ${run}` });
    expect(dry.data.plan.add[0].items.map((i: any) => i.priceCents)).toEqual([107, 534, 10680]); // +20%
    expect(await offerOf(big, "pubg:60 UC")).toBeUndefined(); // a preview changes nothing

    const r = await select(big, { ...body, dryRun: false });
    expect(r.status).toBe(200);
    expect(r.data.version).toBe(version + 1);
    const o = (await offerOf(big, "pubg:60 UC"))!;
    expect(o).toMatchObject({ active: true, price_cents: "107", name_en: "60 UC" });
    const p = (await db.query<{ active: boolean; description_en: string; description_ar: string; slug: string; kind: string }>(
      `select active, description_en, description_ar, slug, kind from app.products where id = $1`, [o.product_id],
    ))[0]!;
    expect(p).toMatchObject({ active: true, description_en: `Buy Game PUBG ${run} here.`, kind: "id" });
    expect(p.slug).toBe(`game-pubg-${run}`);
    const fields = (await db.query<{ input_fields: unknown }>(`select input_fields from app.offers where id = $1`, [o.id]))[0]!.input_fields;
    expect(fields).toEqual([{ key: "player_id", labelEn: "Player ID", required: true }]);
    expect((await db.query(`select 1 from app.audit_log where action = 'supplier.selection' and target_id = $1`, [big])).length).toBe(1);
  });

  it("refuses a screen loaded before someone else's change", async () => {
    const stale = await select(big, { version: 0, add: ["ff:100 Diamonds"] });
    expect(stale.status).toBe(409);
    expect(stale.data.field ?? stale.data.error?.field ?? JSON.stringify(stale.data)).toContain("version");
  });

  it("refuses an item the supplier does not list", async () => {
    const version = (await catalogue(big)).data.version;
    // ff was never read: its items are unknown until the group is opened.
    expect((await select(big, { version, add: ["ff:100 Diamonds"] })).status).toBe(400);
    expect((await select(big, { version, add: ["pubg:9999 UC"] })).status).toBe(400);
    expect((await select(big, { version, remove: ["pubg:not-sold"] })).status).toBe(400);
  });

  it("adds a new package of a game the store sells to that game's product", async () => {
    games.pubg!.push(pkg("pubg", "16200 UC", 17800));
    // The group was first read an hour ago, so what appears now is new.
    await db.query(`update app.supplier_groups set first_items_at = now() - interval '1 hour' where supplier_id = $1`, [big]);
    await h.call("POST", `/api/admin/suppliers/${big}/catalogue/refresh`, { token: owner, body: { group: "game:pubg" } });
    const list = await items(big, "game:pubg");
    expect(list.data.items.find((i: any) => i.packageName === "16200 UC").fresh).toBe(true);
    const version = (await catalogue(big)).data.version;
    const r = await select(big, { version, add: ["pubg:16200 UC"] });
    expect(r.data.plan.add[0].isNew).toBe(false);
    expect((await offerOf(big, "pubg:16200 UC"))!.product_id).toBe((await offerOf(big, "pubg:60 UC"))!.product_id);
  });

  it("deletes a package never ordered, archives one with orders, hides an empty product, and brings one back", async () => {
    const sold = (await offerOf(big, "pubg:8100 UC"))!;
    await db.query(
      `insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, total_cents, status, channel, idempotency_key)
       values ($1, $2, $3, 1, 10680, 10680, 'delivered', 'web', $4)`,
      [customerId, sold.id, sold.product_id, `sel-${run}-1`],
    );
    let version = (await catalogue(big)).data.version;
    const all = ["pubg:60 UC", "pubg:325 UC", "pubg:8100 UC", "pubg:16200 UC"];
    const dry = await select(big, { version, remove: all, dryRun: true });
    expect(dry.data.plan.remove.map((r: any) => [r.ref, r.action]).sort()).toEqual([
      ["pubg:16200 UC", "delete"], ["pubg:325 UC", "delete"], ["pubg:60 UC", "delete"], ["pubg:8100 UC", "archive"],
    ]);
    expect(dry.data.plan.hide).toHaveLength(1);
    const r = await select(big, { version, remove: all });
    expect(r.status).toBe(200);
    expect(await offerOf(big, "pubg:60 UC")).toBeUndefined();
    expect((await offerOf(big, "pubg:8100 UC"))!.active).toBe(false); // kept for its order
    expect((await db.query<{ active: boolean }>(`select active from app.products where id = $1`, [sold.product_id]))[0]!.active).toBe(false);

    // Ticking it again brings the same package back, and shows its product again.
    version = r.data.version;
    const back = await select(big, { version, add: ["pubg:8100 UC"] });
    expect(back.status).toBe(200);
    expect(back.data.plan.add[0].items[0].reactivate).toBe(true);
    expect((await offerOf(big, "pubg:8100 UC"))).toMatchObject({ id: sold.id, active: true });
    expect((await db.query<{ active: boolean }>(`select active from app.products where id = $1`, [sold.product_id]))[0]!.active).toBe(true);
  });

  it("makes one product per item for a supplier whose items stand alone, and leaves other suppliers alone", async () => {
    flatItems = [
      { externalId: "11", name: `Canva Pro ${run}`, costCents: 300, available: true, kind: "account" },
      { externalId: "12", name: `Cursor Pro ${run}`, costCents: 1500, available: true, kind: "account" },
      { externalId: "13", name: "Gone soon", costCents: 100, available: false, kind: "account" },
    ];
    const c = await catalogue(flat); // first visit reads the whole list
    expect(c.data.supplier.grouped).toBe(false);
    expect(c.data.groups).toEqual([expect.objectContaining({ id: "", total: 3, chosen: 0 })]);
    expect((await select(flat, { version: c.data.version, add: ["13"] })).status).toBe(400); // unavailable
    const other = (await catalogue(big)).data.version;
    const r = await select(flat, { version: c.data.version, add: ["11", "12"] });
    expect(r.status).toBe(200);
    expect(r.data.plan.add.map((d: any) => [d.key, d.isNew, d.nameEn])).toEqual([["i:11", true, `Canva Pro ${run}`], ["i:12", true, `Cursor Pro ${run}`]]);
    expect((await offerOf(flat, "11"))!.product_id).not.toBe((await offerOf(flat, "12"))!.product_id);
    expect((await catalogue(big)).data.version).toBe(other);

    // "Add to an existing product" instead of a new one.
    flatItems.push({ externalId: "14", name: `Canva Pro Yearly ${run}`, costCents: 2400, available: true, kind: "account" });
    await h.call("POST", `/api/admin/suppliers/${flat}/catalogue/refresh`, { token: owner, body: {} });
    const canva = (await offerOf(flat, "11"))!.product_id;
    const v = (await catalogue(flat)).data.version;
    const placed = await select(flat, { version: v, add: ["14"], place: { "i:14": { productId: canva } } });
    expect(placed.status).toBe(200);
    expect((await offerOf(flat, "14"))!.product_id).toBe(canva);
  });

  it("puts a new product where the supplier's products of that kind already are", async () => {
    const design = (await db.query<{ id: string }>(`select id from app.categories where slug = 'design'`))[0]!.id;
    const vouchers = (await db.query<{ id: string }>(`select id from app.categories where slug = 'vouchers'`))[0]!.id;
    // The store already sells this supplier's codes under Vouchers.
    const p = await db.query<{ id: string }>(
      `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, $2, 'x', 'x', 'code', true) returning id`,
      [`kind-${run}`, vouchers],
    );
    await db.query(`insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'x', 'x', $2, 'old-code', 100, 120)`, [p[0]!.id, flat]);
    await db.query(`update app.products set category_id = $2 where id = (select product_id from app.offers where supplier_id = $1 and supplier_ref = '11')`, [flat, design]);
    flatItems.push({ externalId: "21", name: `Steam $5 ${run}`, costCents: 500, available: true, kind: "code" });
    flatItems.push({ externalId: "22", name: `Figma Pro ${run}`, costCents: 700, available: true, kind: "account" });
    await h.call("POST", `/api/admin/suppliers/${flat}/catalogue/refresh`, { token: owner, body: {} });
    const v = (await catalogue(flat)).data.version;
    const dry = await select(flat, { version: v, add: ["21", "22"], dryRun: true });
    const cat = (key: string) => dry.data.plan.add.find((d: any) => d.key === key).categoryId;
    expect(cat("i:21")).toBe(vouchers);
    // Accounts: most of this supplier's account products are in the first category, one in Design.
    expect(cat("i:22")).not.toBe(vouchers);
  });

  it("marks what a supplier stops listing as gone, without touching the store", async () => {
    flatItems = flatItems.filter((i) => i.externalId !== "12");
    await h.call("POST", `/api/admin/suppliers/${flat}/catalogue/refresh`, { token: owner, body: {} });
    const list = await items(flat, "");
    expect(list.data.items.find((i: any) => i.ref === "12")).toMatchObject({ missing: true });
    expect((await offerOf(flat, "12"))!.active).toBe(true); // the sync pauses it; the owner decides
    // An empty answer for a whole list is a glitch: nothing is marked gone.
    flatItems = [];
    const r = await h.call("POST", `/api/admin/suppliers/${flat}/catalogue/refresh`, { token: owner, body: {} });
    expect(r.data.ok).toBe(false);
    expect((await items(flat, "")).data.items.find((i: any) => i.ref === "11").missing).toBe(false);
  });

  it("keeps the saved copy fresh from the price check and the scheduled job", async () => {
    games.pubg = games.pubg!.map((p) => (p.externalId === "pubg:8100 UC" ? { ...p, costCents: 9000 } : p));
    await db.query(`update app.suppliers set max_jump_pct = null where id = $1`, [big]);
    await db.query(`update app.offers set cost_checked_at = null where supplier_id = $1`, [big]);
    await syncSupplier(h.svc, big);
    const row = (await items(big, "game:pubg")).data.items.find((i: any) => i.ref === "pubg:8100 UC");
    expect(row.costCents).toBe(9000);

    games.ff = [pkg("ff", "100 Diamonds", 95), pkg("ff", "310 Diamonds", 290)];
    listed.length = 0;
    await refreshDueCatalogues(h.svc, { maxGroups: 5 });
    expect(listed).toContain("game:ff");
    expect((await catalogue(big)).data.groups.find((g: any) => g.id === "game:ff").total).toBe(2);
  });
});
