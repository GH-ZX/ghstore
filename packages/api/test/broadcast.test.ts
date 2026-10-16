/** Admin → Broadcast: one message to all customers or to a product's buyers, sent through the outbox. */
import { afterAll, describe, expect, it } from "vitest";
import { sendOutbox } from "../src/notify";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const base = 760_000_000 + (Date.now() % 100_000_000);

afterAll(async () => {
  await conn.close();
});

async function userId(tgId: number): Promise<string> {
  return (await db.query<{ user_id: string }>(`select user_id from app.identities where provider = 'telegram' and subject = $1`, [String(tgId)]))[0]!.user_id;
}

/** A product with one delivered order for the given user. */
async function productBoughtBy(buyer: string): Promise<{ id: string; slug: string }> {
  const slug = `bc-${run}`;
  const p = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active)
     values ($1, (select id from app.categories order by sort limit 1), 'منتج البث', 'Broadcast product', 'code', true) returning id`,
    [slug],
  ))[0]!;
  const o = (await db.query<{ id: string }>(`insert into app.offers (product_id, name_ar, name_en, price_cents) values ($1, 'باقة', 'Pack', 100) returning id`, [p.id]))[0]!;
  await db.query(
    `insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, total_cents, status, channel, idempotency_key)
     values ($1, $2, $3, 1, 100, 100, 'delivered', 'miniapp', $4)`,
    [buyer, o.id, p.id, `bc-order-${run}`],
  );
  return { id: p.id, slug };
}

describe("broadcasts", () => {
  it("are for the owner only", async () => {
    const customer = await h.login(base + 1);
    expect((await h.call("GET", "/api/admin/broadcasts", { token: customer })).status).toBe(403);
    const monitor = await h.login(base + 2);
    await db.query(`update app.users set role = 'monitor' where id = $1`, [await userId(base + 2)]);
    expect((await h.call("POST", "/api/admin/broadcasts", { token: monitor, body: { textAr: "x", audience: "all", idempotencyKey: `k-${run}-m` } })).status).toBe(403);
  });

  it("reach buyers of a product, skip people who turned notifications off, and send with a product button", async () => {
    const owner = await h.login(900001, "Owner");
    await h.login(base + 3, "Buyer", "en");
    await h.login(base + 4, "Quiet buyer");
    await h.login(base + 5, "Not a buyer");
    const buyer = await userId(base + 3);
    const quiet = await userId(base + 4);
    const product = await productBoughtBy(buyer);
    await db.query(
      `insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, total_cents, status, channel, idempotency_key)
       select $1, offer_id, product_id, 1, 100, 100, 'delivered', 'miniapp', $2 from app.orders where user_id = $3 and product_id = $4`,
      [quiet, `bc-order-q-${run}`, buyer, product.id],
    );
    await db.query(`update app.users set notify = false where id = $1`, [quiet]);

    const aud = await h.call("GET", `/api/admin/broadcasts/audience?productId=${product.id}`, { token: owner });
    expect(aud.data.recipients).toBe(1);
    const all = await h.call("GET", "/api/admin/broadcasts/audience", { token: owner });
    expect(all.data.recipients).toBeGreaterThan(1);

    expect((await h.call("POST", "/api/admin/broadcasts", { token: owner, body: { textAr: "", textEn: " ", audience: "all", idempotencyKey: `k-${run}-0` } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/broadcasts", { token: owner, body: { textAr: "x".repeat(1001), audience: "all", idempotencyKey: `k-${run}-0` } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/broadcasts", { token: owner, body: { textAr: "مرحبا", audience: "buyers", idempotencyKey: `k-${run}-0` } })).status).toBe(400);

    const body = { textAr: "عرض جديد على المنتج", textEn: "New deal on this product", audience: "buyers", productId: product.id, button: "product", idempotencyKey: `k-${run}-1` };
    const sent = await h.call("POST", "/api/admin/broadcasts", { token: owner, body });
    expect(sent.status).toBe(201);
    expect(sent.data.broadcast).toMatchObject({ recipients: 1, pending: 1, audience: "buyers", button: "product" });
    // A double tap returns the same broadcast and queues nothing more.
    const again = await h.call("POST", "/api/admin/broadcasts", { token: owner, body });
    expect(again.status).toBe(200);
    expect(again.data.broadcast.id).toBe(sent.data.broadcast.id);
    expect(again.data.broadcast.pending).toBe(1);

    // Receipts go before broadcasts.
    await db.query(`insert into app.outbox (user_id, template, data) values ($1, 'payment_credited', '{"amount_cents": 500}')`, [buyer]);
    h.telegramCalls = [];
    await sendOutbox(h.svc, env, 500);
    const toBuyer = h.telegramCalls.filter((c) => c.payload.chat_id === String(base + 3));
    expect(toBuyer.map((c) => c.payload.text)).toEqual(["$5.00 was added to your balance.", "New deal on this product"]);
    const markup = toBuyer[1]!.payload.reply_markup as { inline_keyboard: { text: string; web_app: { url: string } }[][] };
    expect(markup.inline_keyboard[0]![0]).toEqual({ text: "View", web_app: { url: `${env.PUBLIC_BASE_URL}/tg?startapp=p_${product.slug}` } });
    expect(h.telegramCalls.some((c) => c.payload.chat_id === String(base + 4))).toBe(false);

    const list = await h.call("GET", "/api/admin/broadcasts", { token: owner });
    expect(list.data.broadcasts.find((b: { id: string }) => b.id === sent.data.broadcast.id)).toMatchObject({ sent: 1, pending: 0, failed: 0 });
    const audit = await db.query(`select 1 from app.audit_log where action = 'broadcast.send' and target_id = $1`, [sent.data.broadcast.id]);
    expect(audit.length).toBe(1);
  });

  it("can be cancelled while sending, and a blocked bot is not retried", async () => {
    const owner = await h.login(900001, "Owner");
    await h.login(base + 6, "Blocked");
    const sent = await h.call("POST", "/api/admin/broadcasts", { token: owner, body: { textAr: "خصم اليوم فقط", audience: "all", idempotencyKey: `k-${run}-2` } });
    expect(sent.status).toBe(201);
    const id = sent.data.broadcast.id as string;
    expect(sent.data.broadcast.recipients).toBeGreaterThan(1);
    expect(sent.data.broadcast.textEn).toBe("خصم اليوم فقط"); // one language fills the other

    // Telegram refuses one person; the rest of the first batch goes through.
    const realTelegram = h.svc.telegram;
    h.svc.telegram = async (method, payload, bot) => {
      if (payload.chat_id === String(base + 6)) throw new Error("telegram sendMessage: Forbidden: bot was blocked by the user");
      return realTelegram(method, payload, bot);
    };
    try {
      // Send only the blocked person's message, then cancel the rest.
      const mine = await db.query<{ id: string }>(
        `select o.id from app.outbox o join app.identities i on i.user_id = o.user_id and i.provider = 'telegram' where o.broadcast_id = $1 and i.subject = $2`,
        [id, String(base + 6)],
      );
      await db.query(`update app.outbox set priority = -1 where id = $1`, [mine[0]!.id]);
      await sendOutbox(h.svc, env, 1);
      const row = (await db.query<{ status: string; attempts: number }>(`select status, attempts from app.outbox where id = $1`, [mine[0]!.id]))[0]!;
      expect(row).toEqual({ status: "failed", attempts: 1 });
    } finally {
      h.svc.telegram = realTelegram;
    }

    const cancelled = await h.call("POST", `/api/admin/broadcasts/${id}/cancel`, { token: owner });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.broadcast).toMatchObject({ pending: 0, failed: 1 });
    expect(cancelled.data.broadcast.cancelledAt).toBeTruthy();
    const left = await db.query(`select 1 from app.outbox where broadcast_id = $1 and status = 'pending'`, [id]);
    expect(left.length).toBe(0);
  });

  it("can be tried on the owner first", async () => {
    const owner = await h.login(900001, "Owner");
    const ownerId = await userId(900001);
    const r = await h.call("POST", "/api/admin/broadcasts/test", { token: owner, body: { textAr: `تجربة ${run}`, textEn: `Test ${run}` } });
    expect(r.status).toBe(200);
    const rows = await db.query(`select 1 from app.outbox where user_id = $1 and template = 'broadcast' and data->>'text_ar' = $2 and broadcast_id is null`, [ownerId, `تجربة ${run}`]);
    expect(rows.length).toBe(1);
  });
});
