/**
 * End-to-end API tests against a real Postgres with the migrations applied.
 * Run: TEST_DATABASE_URL=postgres://... vitest run packages/api
 * Each run uses fresh random Telegram ids and product slugs, so reruns don't collide.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaymentAdapter, PurchaseResult, SupplierAdapter, SupplierProduct } from "@store/core";
import { runScheduled, syncSupplier } from "../src/index";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const tg = (k: number) => 700_000_000 + (Date.now() % 100_000_000) + k;

let supplierResult: PurchaseResult = { status: "delivered", supplierOrderId: "S-1", items: [{ kind: "code", value: "CODE-1234-ABCD" }] };
const purchases: string[] = [];
let catalog: () => Promise<SupplierProduct[]> = async () => [
  { externalId: `ext-${run}`, name: "60 UC", costCents: 100, available: true, kind: "id" },
];
const fakeSupplier: SupplierAdapter = {
  id: "fake",
  name: "Fake",
  listProducts: () => catalog(),
  getBalance: async () => ({ amountCents: 500, currency: "USD" }),
  purchase: async (req) => {
    purchases.push(req.idempotencyKey);
    return supplierResult;
  },
  checkOrder: async (id) => ({ status: "delivered", supplierOrderId: id, items: [{ kind: "code", value: "LATE-CODE" }] }),
};

let samPaid = 0;
const fakeSam: PaymentAdapter = {
  id: "sam",
  createPayment: async (input) => ({ providerRef: `inv-${input.paymentId}`, action: { type: "redirect", url: "https://pay.test/x" } }),
  verifyWebhook: async (req) => {
    if (req.headers.get("x-test-sig") !== "ok") return null;
    const body = (await req.json()) as { ref: string };
    return { providerRef: body.ref, status: "paid", amountCents: 999999 }; // body is never trusted for the amount
  },
  checkPayment: async (ref) => ({ providerRef: ref, status: samPaid ? "paid" : "pending", amountCents: samPaid || undefined }),
};

const chainPaid = new Set<string>();
const fakeBep20: PaymentAdapter = {
  id: "bep20",
  createPayment: async (input) => ({ providerRef: input.paymentId, action: { type: "address", network: "BSC (BEP20)", asset: "USDT", address: "0xstore", amount: (input.amountCents / 100).toFixed(2) } }),
  checkPayment: async (txHash, expected) => ({ providerRef: txHash, txHash, status: chainPaid.has(txHash) ? "paid" : "pending", amountCents: expected?.amountCents }),
};

let productId = "";
let offerId = "";

beforeAll(async () => {
  h.suppliers.set("fake", fakeSupplier);
  h.payments.set("sam", fakeSam);
  h.payments.set("bep20", fakeBep20);
  await db.query(`insert into app.suppliers (id, name, enabled, low_balance_cents) values ('fake', 'Fake', true, 1000) on conflict (id) do nothing`);
  const p = await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active, search_terms)
     select $1, id, 'شدات ببجي موبايل', 'PUBG Mobile UC', 'id', true, 'ببجي pubg uc' from app.categories where slug = 'games' returning id`,
    [`pubg-${run}`],
  );
  productId = p[0]!.id;
  const o = await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, input_fields)
     values ($1, '60 شدة', '60 UC', 'fake', $2, 100, 123, $3::text::jsonb) returning id`,
    [productId, `ext-${run}`, JSON.stringify([{ key: "player_id", labelEn: "Player ID", required: true, pattern: "^[0-9]{5,12}$" }])],
  );
  offerId = o[0]!.id;
});

afterAll(async () => {
  await conn.close();
});

describe("auth", () => {
  it("signs in with Telegram and refuses bad data", async () => {
    const token = await h.login(tg(1), "Samer");
    const me = await h.call("GET", "/api/me", { token });
    expect(me.status).toBe(200);
    expect(me.data.balanceCents).toBe(0);
    expect(me.data.user.role).toBe("customer");
    const bad = await h.call("POST", "/api/auth/telegram", { body: { initData: "user=%7B%22id%22%3A1%7D&auth_date=1&hash=" + "0".repeat(64) } });
    expect(bad.status).toBe(401);
    expect((await h.call("GET", "/api/me")).status).toBe(401);
  });

  it("revoked sessions stop working", async () => {
    const token = await h.login(tg(2));
    expect((await h.call("POST", "/api/auth/logout", { token })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { token })).status).toBe(401);
  });

  it("refuses cross-site writes without a bearer token", async () => {
    const r = await h.call("POST", "/api/orders", { body: {}, origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
});

describe("web app support", () => {
  it("serves public config without secrets", async () => {
    const c = await h.call("GET", "/api/config");
    expect(c.status).toBe(200);
    expect(c.data.theme.preset).toBeTruthy();
    expect(c.data.payments.methods).toContain("bep20");
    expect(c.data.login).toEqual(["telegram"]); // no Supabase keys in the test env
    expect(JSON.stringify(c.data)).not.toMatch(/SECRET|TOKEN|DATA_KEY/i);
  });

  it("signs a website visitor in with the Telegram widget, as the same user as the Mini App", async () => {
    const id = tg(30);
    const mini = await h.login(id, "Lina");
    const miniUser = (await h.call("GET", "/api/me", { token: mini })).data.user.id;
    const { BOT_TOKEN } = await import("./helpers");
    const { hmacSha256, toHex } = await import("@store/core");
    const fields: Record<string, string> = { id: String(id), first_name: "Lina", auth_date: String(Math.floor(Date.now() / 1000) - 5) };
    const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN)));
    const body = { ...fields, hash: toHex(await hmacSha256(secret, dcs)) };
    const { handle } = await import("../src/index");
    const { env } = await import("./helpers");
    const res = await handle(new Request("https://store.test/api/auth/telegram-widget", { method: "POST", headers: { origin: env.PUBLIC_BASE_URL, "content-type": "application/json" }, body: JSON.stringify(body) }), env, h.svc);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    const token = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
    const me = await h.call("GET", "/api/me", { token });
    expect(me.data.user.id).toBe(miniUser);
    expect(me.data.channel).toBe("web");
    const bad = await handle(new Request("https://store.test/api/auth/telegram-widget", { method: "POST", headers: { origin: env.PUBLIC_BASE_URL }, body: JSON.stringify({ ...body, id: "1" }) }), env, h.svc);
    expect(bad.status).toBe(401);
  });
});

describe("catalog", () => {
  it("lists sellable products and finds Arabic spelling variants", async () => {
    const all = await h.call("GET", `/api/catalog`);
    const mine = all.data.products.find((p: any) => p.id === productId);
    expect(mine.fromCents).toBe(123);
    expect(JSON.stringify(all.data)).not.toContain("cost");
    const q = await h.call("GET", `/api/catalog?q=${encodeURIComponent("ببجى")}`);
    expect(q.data.products.some((p: any) => p.id === productId)).toBe(true);
    const prod = await h.call("GET", `/api/products/pubg-${run}`);
    expect(prod.data.offers[0].fields[0].key).toBe("player_id");
  });
});

describe("top-up, order, delivery, refund", () => {
  let token = "";
  let paymentId = "";

  it("credits a top-up only after the provider confirms, exactly once", async () => {
    token = await h.login(tg(3));
    const t = await h.call("POST", "/api/topups", { token, body: { method: "sam", amountCents: 1000 } });
    expect(t.status).toBe(201);
    paymentId = t.data.paymentId;
    expect(t.data.action.type).toBe("redirect");

    const hook = (sig: string) =>
      h.svc && import("../src/index").then(({ handle }) =>
        handle(new Request("https://store.test/api/webhooks/payments/sam", { method: "POST", headers: { "x-test-sig": sig }, body: JSON.stringify({ ref: `inv-${paymentId}` }) }), {
          ...{ SESSION_SECRET: "test-session-secret-0123456789-abcdefghij", DATA_KEY: "", TELEGRAM_BOT_TOKEN: "", PUBLIC_BASE_URL: "https://store.test" },
        }, h.svc),
      );
    expect((await hook("bad")).status).toBe(401);
    expect((await (await hook("ok")).json()).status).toBe("pending"); // provider still says pending
    samPaid = 1000;
    expect((await (await hook("ok")).json()).status).toBe("paid");
    await hook("ok");
    const me = await h.call("GET", "/api/me", { token });
    expect(me.data.balanceCents).toBe(1000); // not 999999 from the callback body, and not twice
  });

  it("validates input, charges once per idempotency key and delivers", async () => {
    const bad = await h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `k-${run}-0`, input: { player_id: "x" } } });
    expect(bad.status).toBe(400);
    expect(bad.data.error.field).toBe("input.player_id");

    const body = { offerId, idempotencyKey: `k-${run}-1`, input: { player_id: "512345" } };
    const r1 = await h.call("POST", "/api/orders", { token, body });
    expect(r1.status).toBe(201);
    expect(r1.data.balanceCents).toBe(877);
    const r2 = await h.call("POST", "/api/orders", { token, body });
    expect(r2.status).toBe(200);
    expect(r2.data.orderId).toBe(r1.data.orderId);
    await h.settle();

    const o = await h.call("GET", `/api/orders/${r1.data.orderId}`, { token });
    expect(o.data.order.status).toBe("delivered");
    expect(o.data.deliveries[0].value).toBe("CODE-1234-ABCD");
    const stored = await db.query<{ value_enc: string }>(`select value_enc from app.deliveries where order_id = $1`, [r1.data.orderId]);
    expect(stored[0]!.value_enc).not.toContain("CODE-1234");
    expect(purchases.filter((k) => k === r1.data.orderId)).toHaveLength(1);
  });

  it("hides other people's orders", async () => {
    const other = await h.login(tg(4));
    const mine = await h.call("GET", "/api/orders", { token });
    const r = await h.call("GET", `/api/orders/${mine.data.orders[0].id}`, { token: other });
    expect(r.status).toBe(404);
  });

  it("refunds when the supplier rejects the order", async () => {
    supplierResult = { status: "failed", retryable: false, reason: "invalid player id", code: "invalid_input" };
    const r = await h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `k-${run}-2`, input: { player_id: "512345" } } });
    expect(r.data.balanceCents).toBe(754);
    await h.settle();
    const o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token });
    expect(o.data.order.status).toBe("refunded");
    expect((await h.call("GET", "/api/me", { token })).data.balanceCents).toBe(877);
    const w = await h.call("GET", "/api/wallet", { token });
    expect(w.data.entries.map((e: any) => e.kind)).toEqual(["refund", "purchase", "purchase", "topup"]);
  });

  it("keeps retrying pending supplier orders through the scheduled job", async () => {
    supplierResult = { status: "pending", supplierOrderId: "S-PENDING" };
    const r = await h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `k-${run}-3`, input: { player_id: "512345" } } });
    await h.settle();
    expect((await h.call("GET", `/api/orders/${r.data.orderId}`, { token })).data.order.status).toBe("processing");
    await db.query(`update app.orders set next_check_at = now() - interval '1 second' where id = $1`, [r.data.orderId]);
    await runScheduled(h.svc, (await import("./helpers")).env);
    const o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token });
    expect(o.data.order.status).toBe("delivered");
    expect(o.data.deliveries.map((d: any) => d.value)).toContain("LATE-CODE");
    // the job also sent the Telegram notifications queued so far
    expect(h.telegramCalls.some((c) => c.method === "sendMessage")).toBe(true);
  });
});

describe("manual USDT transfers", () => {
  it("credits a verified transaction once and blocks reuse", async () => {
    const a = await h.login(tg(5));
    const b = await h.login(tg(6));
    const hash = "0x" + Array.from({ length: 64 }, (_, i) => ((i + Date.now()) % 16).toString(16)).join("");
    const pa = await h.call("POST", "/api/topups", { token: a, body: { method: "bep20", amountCents: 1000 } });
    expect(pa.data.action.type).toBe("address");
    expect((await h.call("GET", `/api/topups/${pa.data.paymentId}`, { token: a })).data.stage).toBe("await_hash");
    // A hash still waiting for confirmations: the app can resume "checking" after a reload.
    const early = "0x" + "c".repeat(64);
    expect((await h.call("POST", `/api/topups/${pa.data.paymentId}/tx`, { token: a, body: { txHash: early } })).data.status).toBe("pending");
    const resumed = await h.call("GET", `/api/topups/${pa.data.paymentId}`, { token: a });
    expect(resumed.data.stage).toBe("checking");
    expect(resumed.data.txHash).toBe(early);
    chainPaid.add(hash);
    const sa = await h.call("POST", `/api/topups/${pa.data.paymentId}/tx`, { token: a, body: { txHash: hash } });
    expect(sa.data.status).toBe("paid");
    // The customer is asked for a unique amount just above the request, and credited exactly that.
    expect(pa.data.amountCents).toBeGreaterThan(1000);
    expect(pa.data.amountCents).toBeLessThan(1100);
    expect(pa.data.action.amount).toBe((pa.data.amountCents / 100).toFixed(2));
    expect((await h.call("GET", "/api/me", { token: a })).data.balanceCents).toBe(pa.data.amountCents);
    const pb = await h.call("POST", "/api/topups", { token: b, body: { method: "bep20", amountCents: 1000 } });
    const pc = await h.call("POST", "/api/topups", { token: b, body: { method: "bep20", amountCents: 1000 } });
    expect(pc.data.amountCents).not.toBe(pb.data.amountCents); // open requests never share an amount
    const sb = await h.call("POST", `/api/topups/${pb.data.paymentId}/tx`, { token: b, body: { txHash: hash.toUpperCase().replace("0X", "0x") } });
    expect(sb.status).toBe(409);
    expect(sb.data.error.code).toBe("tx_reused");
  });

  it("does not offer Stars outside Telegram", async () => {
    // Website sessions use cookies; a Mini App token is a bearer token. Stars require the Mini App.
    const t = await h.login(tg(7));
    const r = await h.call("POST", "/api/topups", { token: t, body: { method: "stars", amountCents: 500 } });
    expect(r.status).toBe(409); // no Stars adapter configured in this test
  });
});

describe("admin", () => {
  it("is staff-only, validates settings and audits changes", async () => {
    const customer = await h.login(tg(8));
    expect((await h.call("GET", "/api/admin/overview", { token: customer })).status).toBe(403);

    await db.query(`delete from app.identities where provider = 'telegram' and subject = '900001'`);
    const owner = await h.login(900001, "Owner");
    const ov = await h.call("GET", "/api/admin/overview", { token: owner });
    expect(ov.status).toBe(200);
    expect(ov.data.suppliers.find((s: any) => s.id === "fake")).toBeTruthy();

    expect((await h.call("PUT", "/api/admin/settings/theme.preset", { token: owner, body: { value: "warm" } })).status).toBe(200);
    expect((await h.call("PUT", "/api/admin/settings/theme.preset", { token: owner, body: { value: "neon" } })).status).toBe(400);
    expect((await h.call("PUT", "/api/admin/settings/supplier.g2bulk.url", { token: owner, body: { value: "https://evil" } })).status).toBe(404);
    const s = await h.call("GET", "/api/admin/settings", { token: owner });
    expect(s.data.settings["theme.preset"]).toBe("warm");
    const audits = await db.query(`select 1 from app.audit_log where action = 'setting.update' and target_id = 'theme.preset'`);
    expect(audits.length).toBeGreaterThan(0);
  });

  it("builds the catalogue: product, imported offer, margin floor, manual stock", async () => {
    const owner = await h.login(900001, "Owner");
    const support = await h.login(tg(20));
    await db.query(`update app.users set role = 'support' where id = (select user_id from app.identities where provider = 'telegram' and subject = $1)`, [String(tg(20))]);
    expect((await h.call("GET", "/api/admin/catalog", { token: support })).status).toBe(403);

    const cat = await h.call("GET", "/api/admin/catalog", { token: owner });
    const games = cat.data.categories.find((c: any) => c.slug === "games");
    const p = await h.call("POST", "/api/admin/products", {
      token: owner,
      body: { slug: `ff-${run}`, categoryId: games.id, nameAr: "فري فاير", nameEn: "Free Fire", kind: "id", active: true, imageUrl: "javascript:alert(1)" },
    });
    expect(p.status).toBe(400); // only https images
    const p2 = await h.call("POST", "/api/admin/products", {
      token: owner,
      body: { slug: `ff-${run}`, categoryId: games.id, nameAr: "فري فاير", nameEn: "Free Fire", kind: "id", active: true, searchTerms: "فري فاير ff" },
    });
    expect(p2.status).toBe(201);
    const pid = p2.data.id;

    // Import: the supplier listing shows which refs are already linked.
    catalog = async () => [
      { externalId: `ext-${run}`, name: "60 UC", costCents: 100, available: true, kind: "id" },
      { externalId: `ff-100-${run}`, name: "100 Diamonds", costCents: 95, available: true, kind: "id" },
    ];
    const list = await h.call("GET", "/api/admin/suppliers/fake/products", { token: owner });
    expect(list.data.items.find((i: any) => i.externalId === `ext-${run}`).offerId).toBe(offerId);
    expect(list.data.items.find((i: any) => i.externalId === `ff-100-${run}`).offerId).toBeNull();

    const o = await h.call("POST", `/api/admin/products/${pid}/offers`, {
      token: owner,
      body: { nameAr: "100 جوهرة", nameEn: "100 Diamonds", supplierId: "fake", supplierRef: `ff-100-${run}`, costCents: 95, markupMode: "percent", markupValue: 20, roundToCents: 5,
        inputFields: [{ key: "player_id", labelEn: "Player ID", labelAr: "معرف اللاعب", pattern: "^[0-9]{6,12}$" }] },
    });
    expect(o.status).toBe(201);
    expect(o.data.priceCents).toBe(115); // 95 * 1.2 = 114 → rounded up to 115
    const dup = await h.call("POST", `/api/admin/products/${pid}/offers`, { token: owner, body: { nameAr: "x", nameEn: "x", supplierId: "fake", supplierRef: `ff-100-${run}`, costCents: 95 } });
    expect(dup.status).toBe(409); // one supplier item, one offer

    // A manual price under the margin floor is refused.
    const low = await h.call("PATCH", `/api/admin/offers/${o.data.id}`, { token: owner, body: { markupMode: "manual", priceCents: 96 } });
    expect(low.status).toBe(400);
    const ok = await h.call("PATCH", `/api/admin/offers/${o.data.id}`, { token: owner, body: { markupMode: "manual", priceCents: 120 } });
    expect(ok.data.priceCents).toBe(120);

    // Manual stock: stored encrypted, sold to the buyer, delivered decrypted.
    const m = await h.call("POST", `/api/admin/products/${pid}/offers`, { token: owner, body: { nameAr: "بطاقة", nameEn: "Card", markupMode: "manual", priceCents: 200 } });
    expect(m.status).toBe(201);
    expect((await h.call("POST", `/api/admin/offers/${o.data.id}/stock`, { token: owner, body: { items: ["X"] } })).status).toBe(409); // supplier offers have no stock
    // Manual-stock packages take a typed cost; supplier packages get theirs from the sync.
    expect((await h.call("PATCH", `/api/admin/offers/${m.data.id}`, { token: owner, body: { costCents: 150, markupMode: "percent", markupValue: 20 } })).data.priceCents).toBe(180);
    expect((await h.call("PATCH", `/api/admin/offers/${o.data.id}`, { token: owner, body: { costCents: 10 } })).status).toBe(400);
    await h.call("PATCH", `/api/admin/offers/${m.data.id}`, { token: owner, body: { markupMode: "manual", priceCents: 200 } });
    const st = await h.call("POST", `/api/admin/offers/${m.data.id}/stock`, { token: owner, body: { items: ["CARD-AAA-111", "CARD-BBB-222"] } });
    expect(st.data.added).toBe(2);
    const raw = await db.query<{ payload_enc: string }>(`select payload_enc from app.stock_items where offer_id = $1`, [m.data.id]);
    expect(raw.every((r) => r.payload_enc.startsWith("v1.") && !r.payload_enc.includes("CARD"))).toBe(true);

    const buyer = await h.login(tg(21));
    const uid = (await h.call("GET", "/api/me", { token: buyer })).data.user.id;
    await h.call("POST", `/api/admin/users/${uid}/wallet`, { token: owner, body: { amountCents: 500, note: "test credit", idempotencyKey: crypto.randomUUID() } });
    const order = await h.call("POST", "/api/orders", { token: buyer, body: { offerId: m.data.id, quantity: 1, idempotencyKey: crypto.randomUUID() } });
    expect(order.status).toBe(201);
    const got = await h.call("GET", `/api/orders/${order.data.orderId}`, { token: buyer });
    expect(got.data.order.status).toBe("delivered");
    expect(JSON.stringify(got.data)).toContain("CARD-AAA-111");

    const me = await h.call("GET", "/api/me", { token: buyer });
    expect(me.data.stats).toEqual({ orders: 1, spentCents: 200 });
    const found = await h.call("GET", `/api/admin/users?q=${uid}`, { token: owner });
    expect(found.data.users[0].balanceCents).toBe(300);
    expect((await h.call("GET", "/api/admin/users?q=%25", { token: owner })).status).toBe(200); // wildcards are escaped
    expect((await h.call("GET", "/api/admin/users", { token: buyer })).status).toBe(403);

    const sup = await h.call("PATCH", "/api/admin/suppliers/fake", { token: owner, body: { lowBalanceCents: 2000 } });
    expect(sup.status).toBe(200);
    const audits = await db.query(`select action from app.audit_log where action in ('product.create','offer.create','offer.update','stock.add','supplier.update')`);
    expect(new Set(audits.map((a: any) => a.action)).size).toBe(5);
  });
});

describe("bot", () => {
  const post = (update: unknown, secret = "test-webhook-secret-abcdef123456") =>
    import("../src/index").then(async ({ handleBotWebhook }) => {
      const { env } = await import("./helpers");
      return handleBotWebhook(
        new Request("https://store.test/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) }),
        env,
        h.svc,
      );
    });

  it("refuses updates without the webhook secret", async () => {
    expect((await post({}, "wrong-secret-wrong-secret")).status).toBe(401);
  });

  it("answers /start with a Mini App button in the user's language", async () => {
    h.telegramCalls.length = 0;
    await post({ message: { chat: { id: 5, type: "private" }, from: { id: 5, first_name: "Sam", language_code: "en" }, text: "/start ref_abc" } });
    const call = h.telegramCalls.find((c) => c.method === "sendMessage")!;
    expect(String(call.payload.text)).toContain("Hi Sam");
    expect(JSON.stringify(call.payload.reply_markup)).toContain("https://store.test/tg?startapp=ref_abc");
  });

  it("takes Stars only for the right payer and amount, and credits once", async () => {
    await db.query(`update app.settings set value = '100' where key = 'payments.stars_per_usd'`);
    const id = tg(9);
    const token = await h.login(id);
    h.payments.set("stars", {
      id: "stars",
      createPayment: async (i) => ({ providerRef: i.paymentId, action: { type: "telegram_invoice", url: "https://t.me/$inv" } }),
    });
    const t = await h.call("POST", "/api/topups", { token, body: { method: "stars", amountCents: 500 } });
    expect(t.status).toBe(201);
    const paymentId = t.data.paymentId;

    h.telegramCalls.length = 0;
    await post({ pre_checkout_query: { id: "q1", from: { id: 1 }, currency: "XTR", total_amount: 500, invoice_payload: paymentId } });
    expect(h.telegramCalls[0]!.payload.ok).toBe(false); // someone else's account
    await post({ pre_checkout_query: { id: "q2", from: { id }, currency: "XTR", total_amount: 499, invoice_payload: paymentId } });
    expect(h.telegramCalls[1]!.payload.ok).toBe(false); // too few Stars
    await post({ pre_checkout_query: { id: "q3", from: { id }, currency: "XTR", total_amount: 500, invoice_payload: paymentId } });
    expect(h.telegramCalls[2]!.payload.ok).toBe(true);

    const paidUpdate = { message: { chat: { id, type: "private" }, from: { id }, successful_payment: { currency: "XTR", total_amount: 500, invoice_payload: paymentId, telegram_payment_charge_id: `ch-${run}` } } };
    await post(paidUpdate);
    await post(paidUpdate);
    expect((await h.call("GET", "/api/me", { token })).data.balanceCents).toBe(500);
  });
});

describe("supplier sync and margin guard", () => {
  it("reprices, pauses on lost margin or availability, resumes, and ignores failed syncs", async () => {
    const mk = async (ref: string, mode: string, price: number) =>
      (await db.query<{ id: string }>(
        `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, markup_mode, markup_value, min_margin_pct)
         values ($1, 'x', 'x', 'fake', $2, 100, $3, $4, 15, 5) returning id`,
        [productId, ref, price, mode],
      ))[0]!.id;
    const auto = await mk(`auto-${run}`, "percent", 115);
    const manual = await mk(`manual-${run}`, "manual", 123);
    const gone = await mk(`gone-${run}`, "percent", 115);
    const state = async (id: string) => (await db.query<{ price_cents: string | number; paused_reason: string | null }>(`select price_cents, paused_reason from app.offers where id = $1`, [id]))[0]!;

    catalog = async () => [
      { externalId: `ext-${run}`, name: "60 UC", costCents: 100, available: true, kind: "id" },
      { externalId: `auto-${run}`, name: "a", costCents: 200, available: true, kind: "id" },
      { externalId: `manual-${run}`, name: "m", costCents: 120, available: true, kind: "id" },
    ];
    const r1 = await syncSupplier(h.svc, "fake");
    expect(Number((await state(auto)).price_cents)).toBe(230);
    expect((await state(manual)).paused_reason).toBe("cost_above_margin");
    expect((await state(gone)).paused_reason).toBe("supplier_unavailable");
    expect(r1.repriced).toBeGreaterThanOrEqual(1);

    catalog = async () => {
      throw new Error("timeout");
    };
    await syncSupplier(h.svc, "fake");
    expect((await state(auto)).paused_reason).toBeNull(); // a failed sync pauses nothing

    catalog = async () => [
      { externalId: `ext-${run}`, name: "60 UC", costCents: 100, available: true, kind: "id" },
      { externalId: `auto-${run}`, name: "a", costCents: 200, available: true, kind: "id" },
      { externalId: `manual-${run}`, name: "m", costCents: 110, available: true, kind: "id" },
      { externalId: `gone-${run}`, name: "g", costCents: 100, available: true, kind: "id" },
    ];
    await syncSupplier(h.svc, "fake");
    expect((await state(manual)).paused_reason).toBeNull();
    expect((await state(gone)).paused_reason).toBeNull();
    const changes = await db.query(`select action from app.price_changes where offer_id = $1`, [manual]);
    expect(changes.length).toBe(1);
  });
});
