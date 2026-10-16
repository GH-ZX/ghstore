/** Email receipts through Resend: their own outbox rows, escaped, never with codes, and only when set up. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearStoreKeysCache } from "../src/keys";
import { sendOutbox } from "../src/notify";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const base = 790_000_000 + (Date.now() % 100_000_000);
const KEY = "re_test_0123456789abcdef";

let sentMail: { url: string; headers: Headers; body: Record<string, any> }[] = [];
let resendStatus = 200;
h.fetchImpl = async (input, init) => {
  const url = String(input);
  if (url !== "https://api.resend.com/emails") return new Response("not mocked", { status: 500 });
  sentMail.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
  return resendStatus === 200 ? Response.json({ id: "email-1" }) : Response.json({ name: "validation_error", message: "The gh-store.me domain is not verified." }, { status: resendStatus });
};

let owner = "";
beforeAll(async () => {
  owner = await h.login(900001, "Owner");
});

afterAll(async () => {
  await db.query(`delete from app.store_keys where name = 'RESEND_API_KEY'`);
  await db.query(`update app.settings set value = 'null' where key = 'email.from'`);
  await db.query(`update app.settings set value = 'true' where key = 'email.receipts'`);
  clearStoreKeysCache();
  await conn.close();
});

async function userId(tgId: number): Promise<string> {
  return (await db.query<{ user_id: string }>(`select user_id from app.identities where provider = 'telegram' and subject = $1`, [String(tgId)]))[0]!.user_id;
}

async function withEmail(uid: string, email: string): Promise<void> {
  await db.query(`insert into app.identities (user_id, provider, subject, email) values ($1, 'supabase', gen_random_uuid()::text, $2)`, [uid, email]);
}

/** Run the outbox until nothing is due (email copies are queued by the first pass). */
async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await sendOutbox(h.svc, env, 500);
    await db.query(`update app.outbox set available_at = now() where status = 'pending'`);
  }
}

async function setUp(): Promise<void> {
  expect((await h.call("PUT", "/api/admin/keys/RESEND_API_KEY", { token: owner, body: { value: KEY } })).status).toBe(200);
  expect((await h.call("PUT", "/api/admin/settings/email.from", { token: owner, body: { value: "GH Store <orders@gh-store.test>" } })).status).toBe(200);
}

describe("email receipts", () => {
  it("are not sent until the owner sets a key and a sender", async () => {
    const id = base + 1;
    await h.login(id, "Rami", "en");
    const uid = await userId(id);
    await withEmail(uid, `rami-${run}@example.com`);
    await db.query(`insert into app.outbox (user_id, template, data) values ($1, 'payment_credited', '{"amount_cents": 700}')`, [uid]);
    sentMail = [];
    await drain();
    expect(sentMail).toEqual([]);
    expect((await db.query(`select 1 from app.outbox where user_id = $1 and channel = 'email'`, [uid])).length).toBe(0);
    expect((await h.call("PUT", "/api/admin/settings/email.from", { token: owner, body: { value: "not an address" } })).status).toBe(400);
    expect((await h.call("PUT", "/api/admin/keys/RESEND_API_KEY", { token: owner, body: { value: "sk_wrong" } })).status).toBe(400);
  });

  it("go to the linked email as their own message, escaped, without codes", async () => {
    await setUp();
    const id = base + 2;
    await h.login(id, "Maya", "en");
    const uid = await userId(id);
    await withEmail(uid, `maya-${run}@example.com`);
    // A delivered order for a product whose name tries to inject HTML.
    const slug = `mail-${run}`;
    const p = (await db.query<{ id: string }>(
      `insert into app.products (slug, category_id, name_ar, name_en, kind, active)
       values ($1, (select id from app.categories order by sort limit 1), 'بطاقة', 'Card <script>x</script>', 'code', true) returning id`,
      [slug],
    ))[0]!;
    const o = (await db.query<{ id: string }>(`insert into app.offers (product_id, name_ar, name_en, price_cents) values ($1, '10$', '$10', 1000) returning id`, [p.id]))[0]!;
    const order = (await db.query<{ number: string }>(
      `insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, total_cents, status, channel, idempotency_key)
       values ($1, $2, $3, 1, 1000, 1000, 'delivered', 'web', $4) returning number`,
      [uid, o.id, p.id, `mail-order-${run}`],
    ))[0]!;
    await db.query(`insert into app.outbox (user_id, template, data) values ($1, 'order_delivered', $2::text::jsonb)`, [uid, JSON.stringify({ number: Number(order.number) })]);

    sentMail = [];
    h.telegramCalls = [];
    await drain();
    expect(h.telegramCalls.some((c) => c.payload.chat_id === String(id))).toBe(true);
    const mine = sentMail.filter((m) => m.body.to[0] === `maya-${run}@example.com`);
    expect(mine).toHaveLength(1);
    const m = mine[0]!;
    expect(m.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(m.headers.get("idempotency-key")).toMatch(/^outbox-\d+$/);
    expect(m.body.from).toBe("GH Store <orders@gh-store.test>");
    expect(m.body.subject).toBe(`Order GH-${order.number} is delivered`);
    expect(m.body.html).toContain("Card &lt;script&gt;x&lt;/script&gt;");
    expect(m.body.html).not.toContain("<script>");
    expect(m.body.text).toContain(`${env.PUBLIC_BASE_URL}/orders`);
    // Sending again does not repeat it.
    await drain();
    expect(sentMail.filter((x) => x.body.to[0] === `maya-${run}@example.com`)).toHaveLength(1);
  });

  it("reach website-only customers, respect the notifications switch and the receipts switch", async () => {
    await setUp();
    // A customer with only an email login (no Telegram).
    const webOnly = (await db.query<{ id: string }>(`insert into app.users (display_name, locale) values ('Web Only', 'ar') returning id`))[0]!.id;
    await withEmail(webOnly, `web-${run}@example.com`);
    const quiet = (await db.query<{ id: string }>(`insert into app.users (display_name, locale, notify) values ('Quiet', 'en', false) returning id`))[0]!.id;
    await withEmail(quiet, `quiet-${run}@example.com`);
    for (const u of [webOnly, quiet]) {
      await db.query(`insert into app.outbox (user_id, template, data) values ($1, 'payment_credited', '{"amount_cents": 250}')`, [u]);
    }
    sentMail = [];
    await drain();
    expect(sentMail.map((m) => m.body.to[0]).filter((t: string) => t.endsWith(`-${run}@example.com`))).toEqual([`web-${run}@example.com`]);
    const ar = sentMail.find((m) => m.body.to[0] === `web-${run}@example.com`)!;
    expect(ar.body.subject).toBe("أُضيف $2.50 إلى رصيدك");
    expect(ar.body.html).toContain('dir="rtl"');

    await h.call("PUT", "/api/admin/settings/email.receipts", { token: owner, body: { value: false } });
    await db.query(`insert into app.outbox (user_id, template, data) values ($1, 'payment_credited', '{"amount_cents": 300}')`, [webOnly]);
    sentMail = [];
    await drain();
    expect(sentMail).toEqual([]);
    await h.call("PUT", "/api/admin/settings/email.receipts", { token: owner, body: { value: true } });
  });

  it("retry when Resend refuses, then give up", async () => {
    await setUp();
    const u = (await db.query<{ id: string }>(`insert into app.users (display_name, locale) values ('Retry', 'en') returning id`))[0]!.id;
    await withEmail(u, `retry-${run}@example.com`);
    await db.query(`insert into app.outbox (user_id, channel, template, data) values ($1, 'email', 'payment_credited', '{"amount_cents": 100}')`, [u]);
    resendStatus = 422;
    try {
      for (let i = 0; i < 6; i++) await drain();
    } finally {
      resendStatus = 200;
    }
    const row = (await db.query<{ status: string; last_error: string }>(`select status, last_error from app.outbox where user_id = $1 and channel = 'email'`, [u]))[0]!;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("domain is not verified");
  });

  it("send the owner a test at their linked email", async () => {
    await setUp();
    const ownerId = await userId(900001);
    await db.query(`delete from app.identities where user_id = $1 and provider = 'supabase'`, [ownerId]);
    const none = await h.call("POST", "/api/admin/email/test", { token: owner, body: {} });
    expect(none.status).toBe(409);
    expect(none.data.error.field).toBe("email.to");
    await withEmail(ownerId, `owner-${run}@example.com`);
    sentMail = [];
    const ok = await h.call("POST", "/api/admin/email/test", { token: owner, body: {} });
    expect(ok.status).toBe(200);
    expect(ok.data.to).toBe(`owner-${run}@example.com`);
    expect(sentMail).toHaveLength(1);
    resendStatus = 403;
    try {
      const refused = await h.call("POST", "/api/admin/email/test", { token: owner, body: {} });
      expect(refused.status).toBe(409);
      expect(refused.data.error.field).toContain("resend 403");
    } finally {
      resendStatus = 200;
    }
    await db.query(`delete from app.identities where user_id = $1 and provider = 'supabase'`, [ownerId]);
  });
});
