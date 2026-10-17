/**
 * v1.1: loyalty cashback (never above the margin), level-up messages; safer
 * top-ups; channel posts; browser notifications (RFC 8291 encryption checked by
 * decrypting like a browser, VAPID checked against the public key).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url, utf8 } from "@store/core";
import type { PaymentAdapter, PaymentEvent, PurchaseResult, SupplierAdapter } from "@store/core";
import { postText, queueChannelPosts, sendChannelPosts } from "../src/channel";
import { encryptPayload, pushToUser, vapidKeys } from "../src/push";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const base = 850_000_000 + (Date.now() % 1_000_000);
const sup = `v11sup_${run}`;
const result: PurchaseResult = { status: "delivered", supplierOrderId: "S", items: [{ kind: "code", value: "C" }] };
const supplier: SupplierAdapter = {
  id: sup, name: "V11", listProducts: async () => [], getBalance: async () => null,
  purchase: async () => ({ ...result, supplierOrderId: `S-${Math.random()}` }), checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};
const sam: PaymentAdapter = {
  id: "sam",
  createPayment: async (input) => ({ providerRef: `SAM-${input.paymentId}`, action: { type: "redirect", url: "https://sam.example/pay" } }),
  checkPayment: async (ref): Promise<PaymentEvent> => ({ providerRef: ref, status: "pending" }),
};

let owner = "";
let ownerId = "";
let productId = "";
let cheap = ""; // price 1000, cost 100: a 2% cashback fits the margin
let thin = ""; // price 1000, cost 995: the margin caps the cashback at 5

const n = (v: unknown) => Number(v ?? 0);
const setting = (key: string, value: unknown) =>
  db.query(`insert into app.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);

beforeAll(async () => {
  h.suppliers.set(sup, supplier);
  h.payments.set("sam", sam);
  await db.query(`insert into app.suppliers (id, name, enabled, max_jump_pct) values ($1, 'V11', true, null)`, [sup]);
  productId = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, (select id from app.categories where slug = 'games'), 'لعبة', 'V11 Game', 'code', true) returning id`,
    [`v11-${run}`],
  ))[0]!.id;
  const offer = async (cost: number) =>
    (await db.query<{ id: string }>(
      `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents) values ($1, 'باقة', 'Pack', $2, $4, $3, 1000) returning id`,
      [productId, sup, cost, `ref-${cost}`],
    ))[0]!.id;
  cheap = await offer(100);
  thin = await offer(995);
  owner = await h.login(900001, "Owner");
  ownerId = (await h.call("GET", "/api/me", { token: owner })).data.user.id;
});

afterAll(async () => {
  await db.query(`delete from app.settings where key like 'loyalty.%' or key like 'channel.%' or key like 'payments.new_account%'`);
  await conn.close();
});

async function customer(i: number, funds = 10_000): Promise<{ token: string; id: string }> {
  const token = await h.login(base + i, `Buyer ${i}`);
  const id = (await h.call("GET", "/api/me", { token })).data.user.id as string;
  if (funds) await db.query(`select * from app.adjust_wallet($1, $2, 'test funds', $3, gen_random_uuid())`, [id, funds, ownerId]);
  return { token, id };
}

async function buy(token: string, offerId: string, key: string): Promise<string> {
  const r = await h.call("POST", "/api/orders", { token, body: { offerId, idempotencyKey: `${key}-${run}`, input: {} } });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  await h.settle();
  return r.data.orderId as string;
}

describe("loyalty cashback", () => {
  it("pays the level's percent back on delivery, never above the margin, and says when a level is reached", async () => {
    await setting("loyalty.enabled", true);
    await setting("loyalty.tiers", [{ min_cents: 500, percent: 2 }, { min_cents: 5000, percent: 3 }]);
    const c = await customer(1);
    const first = await buy(c.token, cheap, "l1");
    const cash = async (orderId: string) =>
      n((await db.query<{ a: string }>(`select coalesce(sum(amount_cents), 0) as a from app.ledger where kind = 'cashback' and ref_id = $1`, [orderId]))[0]!.a);
    // $10 spent reaches level 1 (from $5): 2% of $10 back.
    expect(await cash(first)).toBe(20);
    expect((await db.query(`select 1 from app.outbox where user_id = $1 and template = 'level_up'`, [c.id])).length).toBe(1);
    // A thin margin caps it: price $10, cost $9.95, so at most 5 cents.
    const second = await buy(c.token, thin, "l2");
    expect(await cash(second)).toBe(5);
    const lvl = await h.call("GET", "/api/me/level", { token: c.token });
    expect(lvl.data).toMatchObject({ enabled: true, level: 1, percent: 2, spentCents: 2000, next: { level: 2, minCents: 5000, percent: 3, leftCents: 3000 } });
    const wallet = await h.call("GET", "/api/wallet", { token: c.token });
    expect((wallet.data.entries as { kind: string }[]).filter((e) => e.kind === "cashback")).toHaveLength(2);
  });

  it("pays nothing when switched off", async () => {
    await setting("loyalty.enabled", false);
    const c = await customer(2);
    const id = await buy(c.token, cheap, "l3");
    expect((await db.query(`select 1 from app.ledger where kind = 'cashback' and ref_id = $1`, [id])).length).toBe(0);
    expect((await h.call("GET", "/api/me/level", { token: c.token })).data).toEqual({ enabled: false });
  });

  it("refuses bad tiers in the admin", async () => {
    const bad = await h.call("PUT", "/api/admin/settings/loyalty.tiers", { token: owner, body: { value: [{ min_cents: 500, percent: 2 }, { min_cents: 100, percent: 3 }] } });
    expect(bad.status).toBe(400);
    const tooMuch = await h.call("PUT", "/api/admin/settings/loyalty.tiers", { token: owner, body: { value: [{ min_cents: 500, percent: 50 }] } });
    expect(tooMuch.status).toBe(400);
  });
});

describe("safer top-ups", () => {
  it("limits a brand-new account, and top-ups per hour", async () => {
    await setting("payments.new_account_max_cents", 2000);
    await setting("payments.topups_per_hour", 3);
    const c = await customer(3, 0);
    const big = await h.call("POST", "/api/topups", { token: c.token, body: { method: "sam", amountCents: 5000 } });
    expect(big.status).toBe(403);
    expect(big.data.error.code).toBe("limit_new_account");
    for (let i = 0; i < 3; i++) {
      const ok = await h.call("POST", "/api/topups", { token: c.token, body: { method: "sam", amountCents: 1000 } });
      expect(ok.status).toBe(201);
      await db.query(`update app.payments set status = 'expired' where id = $1`, [ok.data.paymentId]);
    }
    expect((await h.call("POST", "/api/topups", { token: c.token, body: { method: "sam", amountCents: 1000 } })).status).toBe(429);
    await setting("payments.topups_per_hour", 50);
  });
});

describe("channel posts", () => {
  it("announces a new product once, within the day's limit", async () => {
    await setting("channel.chat", "@ghtestchannel");
    await setting("channel.post_new", true);
    await setting("channel.max_per_day", 30);
    await db.query(`update app.channel_posts set status = 'skipped' where status = 'pending'`);
    // Posts sent by earlier runs of a reused test database do not count against today's limit.
    await db.query(`update app.channel_posts set sent_at = sent_at - interval '1 day' where status = 'sent' and sent_at > now() - interval '1 day'`);
    const p = (await db.query<{ id: string }>(
      `insert into app.products (slug, category_id, name_ar, name_en, kind, active, image_url) values ($1, (select id from app.categories where slug = 'games'), 'جديد', 'Brand New ${run}', 'code', true, 'https://img.example/new.png') returning id`,
      [`v11-new-${run}`],
    ))[0]!.id;
    await db.query(`insert into app.offers (product_id, name_ar, name_en, price_cents) values ($1, 'أ', 'A', 250)`, [p]);
    // Only this one is new (other tests' products count as announced).
    await db.query(`update app.products set channel_posted_at = now() where channel_posted_at is null and id <> $1`, [p]);
    await queueChannelPosts(db);
    await queueChannelPosts(db);
    expect((await db.query(`select 1 from app.channel_posts where product_id = $1`, [p])).length).toBe(1);
    h.telegramCalls.length = 0;
    expect(await sendChannelPosts(h.svc, env)).toBe(1);
    const call = h.telegramCalls.find((c) => c.method === "sendPhoto")!;
    expect(call.payload).toMatchObject({ chat_id: "@ghtestchannel", photo: "https://img.example/new.png" });
    expect(String(call.payload.caption)).toContain(`New in the store: Brand New ${run}`);
    expect(String(call.payload.caption)).toContain("من $2.50");
    // Nothing more to send.
    expect(await sendChannelPosts(h.svc, env)).toBe(0);
  });

  it("writes price drops in both languages", () => {
    const text = postText({ kind: "price_drop", data: { offer_ar: "60", offer_en: "60 UC", old_cents: 120, new_cents: 99 }, name_ar: "ببجي", name_en: "PUBG", from_cents: 99 });
    expect(text).toContain("🔻 سعر أقل: ببجي (60)");
    expect(text).toContain("$1.20 → $0.99");
  });
});

/** RFC 8291 decryption, as a browser does it, to check what the store sends. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, ua.privateKey, 256));
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  const ikm = await hk(auth, shared, cat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hk(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), sealed));
  expect(plain[plain.length - 1]).toBe(2); // the last record's delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("browser notifications", () => {
  it("encrypt messages a browser can read (RFC 8291)", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const uaPub = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey)));
    const body = await encryptPayload(utf8("مرحبا · hello"), uaPub, toBase64Url(auth));
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await decrypt(body, ua, auth)).toBe("مرحبا · hello");
  });

  it("subscribe only to real push services, send with a valid VAPID token, and forget gone subscriptions", async () => {
    const c = await customer(4, 0);
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const keys = { p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: toBase64Url(auth) };
    expect((await h.call("POST", "/api/push/subscribe", { token: c.token, body: { endpoint: "https://evil.example/push/1", keys } })).status).toBe(400);
    const endpoint = `https://fcm.googleapis.com/fcm/send/test-${run}`;
    expect((await h.call("POST", "/api/push/subscribe", { token: c.token, body: { endpoint, keys } })).status).toBe(200);

    const sent: { url: string; headers: Headers; body: Uint8Array }[] = [];
    let status = 201;
    h.fetchImpl = async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: new Uint8Array(init?.body as ArrayBuffer) });
      return new Response(null, { status });
    };
    const msg = { title: "GH Store", body: "Order #12 is delivered.", url: "/orders", lang: "en" as const };
    expect(await pushToUser(h.svc, env, c.id, msg, "mailto:test@example.com")).toBe(1);
    expect(sent[0]!.url).toBe(endpoint);
    expect(sent[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(JSON.parse(await decrypt(sent[0]!.body, ua, auth))).toMatchObject({ title: "GH Store", body: "Order #12 is delivered.", url: "/orders" });
    // The VAPID token is signed by the store's key and names the push service.
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(sent[0]!.headers.get("authorization") ?? "")!;
    expect(m[4]).toBe((await vapidKeys(h.svc, env)).publicKey);
    const pub = await crypto.subtle.importKey("raw", fromBase64Url(m[4]!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromBase64Url(m[3]!), utf8(`${m[1]}.${m[2]}`))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(m[2]!)))).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:test@example.com" });
    // The browser unsubscribed: the push service answers 410 and the store forgets it.
    status = 410;
    expect(await pushToUser(h.svc, env, c.id, msg, "mailto:test@example.com")).toBe(0);
    expect((await db.query(`select 1 from app.push_subscriptions where endpoint = $1`, [endpoint])).length).toBe(0);
  });
});
