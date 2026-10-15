/**
 * Referral rewards, coupon codes and the bot's quick commands, end to end
 * against a real Postgres (see helpers.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupplierAdapter } from "@store/core";
import { handleBotWebhook, runScheduled } from "../src/index";
import { queueBuyAgain } from "../src/jobs";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const tg = (k: number) => 600_000_000 + (Date.now() % 100_000_000) + k;

const supplier: SupplierAdapter = {
  id: "promo",
  name: "Promo",
  listProducts: async () => [],
  getBalance: async () => ({ amountCents: 100_000, currency: "USD" }),
  purchase: async () => ({ status: "delivered", supplierOrderId: `P-${Math.random()}`, items: [{ kind: "code", value: "PROMO-CODE" }] }),
  checkOrder: async (id) => ({ status: "delivered", supplierOrderId: id, items: [] }),
};

let productId = "";
let offerId = "";

/** Give a user money through the real payment function (as the tests' superuser). */
async function fund(userToken: string, cents: number) {
  const me = await h.call("GET", "/api/me", { token: userToken });
  const p = await db.query<{ id: string }>(`insert into app.payments (user_id, method, amount_cents, status) values ($1, 'sam', $2, 'pending') returning id`, [me.data.user.id, cents]);
  await db.query(`select * from app.credit_payment($1, $2, $3)`, [p[0]!.id, cents, `promo-${p[0]!.id}`]);
}

const bot = (update: unknown) =>
  handleBotWebhook(
    new Request("https://store.test/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": String(env.TELEGRAM_WEBHOOK_SECRET) }, body: JSON.stringify(update) }),
    env,
    h.svc,
  );
const botText = async (id: number, text: string, lang = "en") => {
  h.telegramCalls.length = 0;
  await bot({ message: { chat: { id, type: "private" }, from: { id, first_name: "Promo", language_code: lang }, text } });
  return h.telegramCalls.find((c) => c.method === "sendMessage")!.payload;
};

beforeAll(async () => {
  h.suppliers.set("promo", supplier);
  await db.query(`insert into app.suppliers (id, name, enabled) values ('promo', 'Promo', true) on conflict (id) do nothing`);
  const p = await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active)
     select $1, id, 'نتفلكس', 'Netflix', 'code', true from app.categories where slug = 'streaming' returning id`,
    [`netflix-${run}`],
  );
  productId = p[0]!.id;
  const o = await db.query<{ id: string }>(
    `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, max_quantity)
     values ($1, 'شهر', '1 month', 'promo', $2, 500, 1000, 3) returning id`,
    [productId, `promo-${run}`],
  );
  offerId = o[0]!.id;
  await db.query(`update app.settings set value = 'true' where key = 'referral.enabled'`);
  await db.query(`update app.settings set value = '5' where key = 'referral.percent'`);
  await db.query(`update app.settings set value = '30' where key = 'referral.days'`);
});

afterAll(async () => {
  await conn.close();
});

describe("referrals", () => {
  let inviter = "";
  let friend = "";
  let code = "";

  it("gives each customer one invite code", async () => {
    inviter = await h.login(tg(1), "Inviter", "en");
    const r = await h.call("GET", "/api/me/referral", { token: inviter });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ enabled: true, percent: 5, days: 30, invited: 0, earnedCents: 0 });
    code = r.data.code;
    expect(code).toMatch(/^[A-Z2-9]{7}$/);
    expect((await h.call("GET", "/api/me/referral", { token: inviter })).data.code).toBe(code);
    expect((await h.call("GET", "/api/me/referral")).status).toBe(401);
  });

  it("links a new customer once, and never to themselves", async () => {
    friend = await h.login(tg(2), "Friend", "en");
    expect((await h.call("POST", "/api/me/referral", { token: inviter, body: { code } })).data.applied).toBe(false);
    expect((await h.call("POST", "/api/me/referral", { token: friend, body: { code: "not a code" } })).data.applied).toBe(false);
    expect((await h.call("POST", "/api/me/referral", { token: friend, body: { code: code.toLowerCase() } })).data.applied).toBe(true);
    expect((await h.call("POST", "/api/me/referral", { token: friend, body: { code } })).data.applied).toBe(false);
    expect((await h.call("GET", "/api/me/referral", { token: inviter })).data.invited).toBe(1);
  });

  it("pays the inviter a share of each delivered order, without showing what the friend bought", async () => {
    await fund(friend, 5000);
    const r = await h.call("POST", "/api/orders", { token: friend, body: { offerId, idempotencyKey: `ref-${run}-1` } });
    expect(r.status).toBe(201);
    await h.settle();
    expect((await h.call("GET", `/api/orders/${r.data.orderId}`, { token: friend })).data.order.status).toBe("delivered");

    const stats = await h.call("GET", "/api/me/referral", { token: inviter });
    expect(stats.data).toMatchObject({ invited: 1, buyers: 1, earnedCents: 50 });
    const w = await h.call("GET", "/api/wallet", { token: inviter });
    expect(w.data.balanceCents).toBe(50);
    expect(w.data.entries[0]).toMatchObject({ kind: "referral", amountCents: 50, productEn: null, productAr: null });
  });

  it("links through the bot's /start r_<code> link", async () => {
    const id = tg(3);
    const msg = await botText(id, `/start r_${code}`);
    expect(String(msg.text)).toContain("Hi Promo");
    expect(JSON.stringify(msg.reply_markup)).not.toContain("startapp=r_");
    const row = await db.query<{ referred_by: string | null }>(
      `select u.referred_by from app.users u join app.identities i on i.user_id = u.id where i.provider = 'telegram' and i.subject = $1`,
      [String(id)],
    );
    const inviterId = (await h.call("GET", "/api/me", { token: inviter })).data.user.id;
    expect(row[0]!.referred_by).toBe(inviterId);
  });

  it("reports nothing when switched off", async () => {
    await db.query(`update app.settings set value = 'false' where key = 'referral.enabled'`);
    expect((await h.call("GET", "/api/me/referral", { token: inviter })).data).toEqual({ enabled: false });
    await db.query(`update app.settings set value = 'true' where key = 'referral.enabled'`);
  });
});

describe("coupons", () => {
  let owner = "";
  let buyer = "";
  let couponId = "";

  it("lets only the owner create coupons, with checked values", async () => {
    owner = await h.login(900001, "Owner", "en");
    buyer = await h.login(tg(10), "Buyer", "en");
    const body = { code: `save-${run}`, percentOff: 10, maxUsesPerUser: 1, note: "launch" };
    expect((await h.call("POST", "/api/admin/coupons", { token: buyer, body })).status).toBe(403);
    expect((await h.call("POST", "/api/admin/coupons", { token: owner, body: { ...body, percentOff: 150 } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/coupons", { token: owner, body: { code: `x-${run}` } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/coupons", { token: owner, body: { ...body, startsAt: "2030-01-02", expiresAt: "2030-01-01" } })).status).toBe(400);
    const c = await h.call("POST", "/api/admin/coupons", { token: owner, body });
    expect(c.status).toBe(201);
    expect(c.data.coupon).toMatchObject({ code: `SAVE-${run}`.toUpperCase(), percentOff: 10, amountOffCents: null, uses: 0, active: true });
    couponId = c.data.coupon.id;
    expect((await h.call("POST", "/api/admin/coupons", { token: owner, body })).status).toBe(409);
  });

  it("quotes a code, then charges exactly the quoted total", async () => {
    await fund(buyer, 3000);
    const q = await h.call("POST", "/api/coupons/quote", { token: buyer, body: { offerId, quantity: 2, code: ` save-${run} ` } });
    expect(q.status).toBe(200);
    expect(q.data).toMatchObject({ discountCents: 200, totalCents: 1800 });
    expect((await h.call("POST", "/api/coupons/quote", { token: buyer, body: { offerId, code: "NOPE" } })).data.error.code).toBe("coupon_invalid");
    expect((await h.call("POST", "/api/coupons/quote", { token: buyer, body: { offerId, code: "!!" } })).data.error.code).toBe("coupon_invalid");

    const r = await h.call("POST", "/api/orders", { token: buyer, body: { offerId, quantity: 2, idempotencyKey: `cp-${run}-1`, coupon: `save-${run}` } });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ totalCents: 1800, discountCents: 200, balanceCents: 1200 });
    const o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token: buyer });
    expect(o.data.order).toMatchObject({ totalCents: 1800, discountCents: 200 });

    const again = await h.call("POST", "/api/orders", { token: buyer, body: { offerId, idempotencyKey: `cp-${run}-2`, coupon: `SAVE-${run}` } });
    expect(again.status).toBe(409);
    expect(again.data.error.code).toBe("coupon_used");
    expect((await h.call("GET", "/api/me", { token: buyer })).data.balanceCents).toBe(1200);
  });

  it("shows uses in the admin and can switch a coupon off", async () => {
    const list = await h.call("GET", "/api/admin/coupons", { token: owner });
    const c = list.data.coupons.find((x: any) => x.id === couponId);
    expect(c).toMatchObject({ uses: 1, discountTotalCents: 200 });
    const p = await h.call("PATCH", `/api/admin/coupons/${couponId}`, { token: owner, body: { active: false, maxUses: 10, amountOffCents: 150 } });
    expect(p.status).toBe(200);
    expect(p.data.coupon).toMatchObject({ active: false, maxUses: 10, amountOffCents: 150, percentOff: null });
    expect((await h.call("PATCH", `/api/admin/coupons/${couponId}`, { token: buyer, body: { active: true } })).status).toBe(403);
    const other = await h.login(tg(11), "Other", "en");
    const q = await h.call("POST", "/api/coupons/quote", { token: other, body: { offerId, code: `save-${run}` } });
    expect(q.data.error.code).toBe("coupon_invalid");
  });

  it("validates the referral settings", async () => {
    expect((await h.call("PUT", "/api/admin/settings/referral.percent", { token: owner, body: { value: 50 } })).status).toBe(400);
    expect((await h.call("PUT", "/api/admin/settings/referral.days", { token: owner, body: { value: 1.5 } })).status).toBe(400);
    expect((await h.call("PUT", "/api/admin/settings/referral.percent", { token: owner, body: { value: 2.5 } })).status).toBe(200);
    expect((await h.call("PUT", "/api/admin/settings/referral.enabled", { token: owner, body: { value: true } })).status).toBe(200);
    const s = await h.call("GET", "/api/admin/settings", { token: owner });
    expect(s.data.settings["referral.percent"]).toBe(2.5);
  });
});

describe("bot commands", () => {
  it("answers /balance, /orders, /invite and /help", async () => {
    const id = tg(20);
    const token = await h.login(id, "Cmd", "en");
    await fund(token, 1500);
    expect(String((await botText(id, "/balance")).text)).toBe("Your balance: $15.00");
    expect(String((await botText(id, "/orders")).text)).toBe("No orders yet.");
    await h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `bot-${run}-1` } });
    await h.settle();
    const orders = await botText(id, "/orders@gh_store1_bot");
    expect(String(orders.text)).toMatch(/GH-\d+ — Netflix · 1 month\nDelivered · \$10\.00/);
    expect(JSON.stringify(orders.reply_markup)).toContain("startapp=orders");

    const invite = await botText(id, "/invite");
    const code = (await h.call("GET", "/api/me/referral", { token })).data.code;
    expect(String(invite.text)).toContain(`https://t.me/gh_store1_bot?start=r_${code}`);
    expect(String((await botText(id, "/help", "ar")).text)).toContain("/balance");
    expect(String((await botText(id, "/nope")).text)).toContain("/help");
  });
});

describe("buy again", () => {
  it("reminds once, with a button that opens the product", async () => {
    const owner = await h.login(900001, "Owner", "en");
    expect((await h.call("PATCH", `/api/admin/offers/${offerId}`, { token: owner, body: { remindAfterDays: 400 } })).status).toBe(400);
    expect((await h.call("PATCH", `/api/admin/offers/${offerId}`, { token: owner, body: { remindAfterDays: 28 } })).status).toBe(200);
    const cat = await h.call("GET", "/api/admin/catalog", { token: owner });
    expect(cat.data.offers.find((o: any) => o.id === offerId).remind_after_days).toBe(28);

    const id = tg(30);
    const token = await h.login(id, "Renew", "en");
    await fund(token, 1000);
    const r = await h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `again-${run}-1` } });
    await h.settle();
    const o = await h.call("GET", `/api/orders/${r.data.orderId}`, { token });
    expect(o.data.order.productSlug).toBe(`netflix-${run}`);
    const row = await db.query<{ days: number }>(`select round(extract(epoch from remind_at - delivered_at) / 86400)::int as days from app.orders where id = $1`, [r.data.orderId]);
    expect(row[0]!.days).toBe(28);

    await db.query(`update app.orders set remind_at = now() - interval '1 minute' where id = $1`, [r.data.orderId]);
    expect(await queueBuyAgain(h.svc)).toBeGreaterThanOrEqual(1);
    expect(await queueBuyAgain(h.svc)).toBe(0);
    h.telegramCalls.length = 0;
    await runScheduled({ ...h.svc, now: () => new Date("2026-01-01T00:01:00Z") }, env);
    const msg = h.telegramCalls.find((c) => c.method === "sendMessage" && c.payload.chat_id === String(id));
    expect(String(msg?.payload.text)).toContain("Time to renew? You bought Netflix (1 month)");
    expect(JSON.stringify(msg?.payload.reply_markup)).toContain(`startapp=p_netflix-${run}`);
    await h.call("PATCH", `/api/admin/offers/${offerId}`, { token: owner, body: { remindAfterDays: null } });
  });
});

describe("customer fields", () => {
  it("keeps supplier field names and only accepts listed choices", async () => {
    const owner = await h.login(900001, "Owner", "en");
    const fields = [
      { key: "رقم المشترك", labelEn: "Subscriber number", labelAr: "رقم المشترك", required: true },
      { key: "Player_ID", labelEn: "Player ID", required: false },
      { key: "server_id", labelEn: "Server", required: true, options: [{ value: "Asia" }, { value: "Europe", labelAr: "أوروبا" }] },
    ];
    const bad = await h.call("POST", `/api/admin/products/${productId}/offers`, {
      token: owner, body: { nameAr: "خيارات", nameEn: "Choices", supplierId: "promo", supplierRef: `fields-${run}`, costCents: 100, inputFields: [{ key: "x{y}", labelEn: "Bad" }] },
    });
    expect(bad.status).toBe(400);
    const o = await h.call("POST", `/api/admin/products/${productId}/offers`, {
      token: owner, body: { nameAr: "خيارات", nameEn: "Choices", supplierId: "promo", supplierRef: `fields-${run}`, costCents: 100, inputFields: fields },
    });
    expect(o.status).toBe(201);
    const detail = await h.call("GET", `/api/products/netflix-${run}`);
    const offer = detail.data.offers.find((x: any) => x.id === o.data.id);
    expect(offer.fields.map((f: any) => f.key)).toEqual(["رقم المشترك", "Player_ID", "server_id"]);
    expect(offer.fields[2].options).toEqual([{ value: "Asia" }, { value: "Europe", labelAr: "أوروبا" }]);

    const token = await h.login(tg(40), "Fields", "en");
    await fund(token, 1000);
    const wrong = await h.call("POST", "/api/orders", { token, body: { offerId: o.data.id, idempotencyKey: `fields-${run}-1`, input: { "رقم المشترك": "0933", server_id: "Mars" } } });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error.field).toBe("input.server_id");
    const ok = await h.call("POST", "/api/orders", { token, body: { offerId: o.data.id, idempotencyKey: `fields-${run}-2`, input: { "رقم المشترك": "0933", server_id: "Asia" } } });
    expect(ok.status).toBe(201);
    await h.settle();
    const order = await h.call("GET", `/api/orders/${ok.data.orderId}`, { token });
    expect(order.data.order.input).toEqual({ "رقم المشترك": "0933", server_id: "Asia" });
  });
});
