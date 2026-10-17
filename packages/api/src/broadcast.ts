/**
 * Admin → Broadcast: the owner sends one Telegram message to every customer, or
 * to everyone who bought a product. Each recipient gets an outbox row at a lower
 * priority than receipts and alerts, so the scheduled job sends the broadcast
 * gradually without delaying anything urgent. People who turned notifications
 * off, or who never used the bot, are not counted and not messaged.
 *
 * Messages are plain text (no Telegram formatting), so nothing in them is
 * interpreted. A double tap on Send is harmless: the client's idempotency key
 * makes the second request return the first broadcast.
 */
import { audit } from "./audit";
import type { Ctx } from "./context";
import { n, one } from "./db";
import { requireStaff } from "./guard";
import { ApiError, json, readJson, uuid, UUID_RE } from "./http";

export const BROADCAST_MAX = 1000;

type Audience = { kind: "all" } | { kind: "buyers"; productId: string };

/** Customers who can receive a broadcast. `$1` is the product id when buying is required. */
function audienceSql(a: Audience): { sql: string; params: unknown[] } {
  const base = `select u.id from app.users u
     where u.status = 'active' and u.notify
       and exists (select 1 from app.identities i where i.user_id = u.id and i.provider = 'telegram')`;
  if (a.kind === "all") return { sql: base, params: [] };
  return {
    sql: `${base} and exists (select 1 from app.orders o where o.user_id = u.id and o.product_id = $1 and o.status = 'delivered')`,
    params: [a.productId],
  };
}

function readAudience(body: Record<string, unknown>): Audience {
  if (body.audience === "all") return { kind: "all" };
  if (body.audience === "buyers") {
    if (typeof body.productId !== "string" || !UUID_RE.test(body.productId)) throw new ApiError("invalid_input", "productId");
    return { kind: "buyers", productId: body.productId };
  }
  throw new ApiError("invalid_input", "audience");
}

async function countAudience(ctx: Ctx, a: Audience): Promise<number> {
  const { sql, params } = audienceSql(a);
  const row = await one<{ c: string | number }>(ctx.svc.db, `select count(*) as c from (${sql}) a`, params);
  return n(row?.c);
}

/** Both languages; a missing one falls back to the other. Control characters other than new lines are dropped. */
function readTexts(body: Record<string, unknown>): { ar: string; en: string } {
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim() : "";
  const ar = clean(body.textAr);
  const en = clean(body.textEn);
  if (!ar && !en) throw new ApiError("invalid_input", "text");
  if (ar.length > BROADCAST_MAX) throw new ApiError("invalid_input", "textAr");
  if (en.length > BROADCAST_MAX) throw new ApiError("invalid_input", "textEn");
  return { ar: ar || en, en: en || ar };
}

/** The product a broadcast is about. */
async function productSlug(ctx: Ctx, productId: string): Promise<string> {
  const p = await one<{ slug: string }>(ctx.svc.db, `select slug from app.products where id = $1`, [productId]);
  if (!p) throw new ApiError("invalid_input", "productId");
  return p.slug;
}

/** How many people a broadcast would reach. */
export async function broadcastAudience(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const q = new URL(ctx.req.url).searchParams;
  const productId = q.get("productId");
  const a: Audience = productId ? { kind: "buyers", productId: uuid(productId, "productId") } : { kind: "all" };
  return json({ recipients: await countAudience(ctx, a) });
}

/** Send the message to the owner only, to see how it looks in Telegram. */
export async function testBroadcast(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req);
  const texts = readTexts(body);
  const slug = body.button === "product" && typeof body.productId === "string" && UUID_RE.test(body.productId) ? await productSlug(ctx, body.productId) : null;
  const hasTelegram = await one(ctx.svc.db, `select 1 from app.identities where user_id = $1 and provider = 'telegram'`, [staff.id]);
  if (!hasTelegram) throw new ApiError("bad_state", "telegram");
  await ctx.svc.db.query(
    `insert into app.outbox (user_id, template, data) values ($1, 'broadcast', $2::text::jsonb)`,
    [staff.id, JSON.stringify({ text_ar: texts.ar, text_en: texts.en, slug, test: true })],
  );
  return json({ ok: true });
}

export async function createBroadcast(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req);
  const key = typeof body.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.idempotencyKey) ? body.idempotencyKey : null;
  if (!key) throw new ApiError("invalid_input", "idempotencyKey");
  const texts = readTexts(body);
  const audience = readAudience(body);
  const button = body.button === "product" ? "product" : "store";
  const productId = audience.kind === "buyers" ? audience.productId : typeof body.productId === "string" && UUID_RE.test(body.productId) ? body.productId : null;
  if (button === "product" && !productId) throw new ApiError("invalid_input", "productId");
  const slug = productId ? await productSlug(ctx, productId) : null;

  const existing = await one<{ id: string }>(ctx.svc.db, `select id from app.broadcasts where idempotency_key = $1`, [key]);
  if (existing) return json({ broadcast: await loadBroadcast(ctx, existing.id) });

  const recipients = await countAudience(ctx, audience);
  if (recipients === 0) throw new ApiError("bad_state", "recipients");

  const { sql, params } = audienceSql(audience);
  const p = params.length; // the audience query uses $1 when it needs a product
  const data = JSON.stringify({ text_ar: texts.ar, text_en: texts.en, slug: button === "product" ? slug : null });
  await ctx.svc.db.query(
    `with aud as (${sql}),
          b as (
            insert into app.broadcasts (text_ar, text_en, audience, product_id, button, recipients, idempotency_key, created_by)
            select $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}::uuid, $${p + 5}, (select count(*) from aud), $${p + 6}, $${p + 7}::uuid
            on conflict (idempotency_key) do nothing
            returning id
          )
     insert into app.outbox (user_id, template, data, priority, broadcast_id)
     select aud.id, 'broadcast', $${p + 8}::text::jsonb, 1, b.id from aud cross join b`,
    [...params, texts.ar, texts.en, audience.kind, productId, button, key, staff.id, data],
  );
  const row = await one<{ id: string }>(ctx.svc.db, `select id from app.broadcasts where idempotency_key = $1`, [key]);
  if (!row) throw new ApiError("internal");
  await audit(ctx.svc.db, { actor: staff.id, action: "broadcast.send", targetType: "broadcast", targetId: row.id, data: { audience: audience.kind, productId, button, recipients } });
  return json({ broadcast: await loadBroadcast(ctx, row.id) }, { status: 201 });
}

/** Stop a broadcast: messages not sent yet are dropped. */
export async function cancelBroadcast(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const b = await one<{ id: string }>(ctx.svc.db, `update app.broadcasts set cancelled_at = coalesce(cancelled_at, now()) where id = $1 returning id`, [id]);
  if (!b) throw new ApiError("not_found");
  const dropped = await ctx.svc.db.query(
    `update app.outbox set status = 'failed', last_error = 'cancelled' where broadcast_id = $1 and status = 'pending' returning id`,
    [id],
  );
  await audit(ctx.svc.db, { actor: staff.id, action: "broadcast.cancel", targetType: "broadcast", targetId: id, data: { dropped: dropped.length } });
  return json({ broadcast: await loadBroadcast(ctx, id) });
}

interface BroadcastRow {
  id: string;
  text_ar: string;
  text_en: string;
  audience: "all" | "buyers";
  product_id: string | null;
  product_ar: string | null;
  product_en: string | null;
  button: "store" | "product";
  recipients: number;
  created_at: string;
  cancelled_at: string | null;
  sent: string | number;
  skipped: string | number;
  failed: string | number;
  pending: string | number;
}

const BROADCAST_SELECT = `
  select b.id, b.text_ar, b.text_en, b.audience, b.product_id, p.name_ar as product_ar, p.name_en as product_en,
         b.button, b.recipients, b.created_at, b.cancelled_at,
         count(o.id) filter (where o.status = 'sent' and o.last_error is null) as sent,
         count(o.id) filter (where o.status = 'sent' and o.last_error is not null) as skipped,
         count(o.id) filter (where o.status = 'failed' and o.last_error is distinct from 'cancelled') as failed,
         count(o.id) filter (where o.status = 'pending') as pending
    from app.broadcasts b
    left join app.products p on p.id = b.product_id
    left join app.outbox o on o.broadcast_id = b.id`;

function publicBroadcast(r: BroadcastRow) {
  return {
    id: r.id,
    textAr: r.text_ar,
    textEn: r.text_en,
    audience: r.audience,
    productId: r.product_id,
    productAr: r.product_ar,
    productEn: r.product_en,
    button: r.button,
    recipients: r.recipients,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
    sent: n(r.sent),
    skipped: n(r.skipped),
    failed: n(r.failed),
    pending: n(r.pending),
  };
}

async function loadBroadcast(ctx: Ctx, id: string) {
  const r = await one<BroadcastRow>(ctx.svc.db, `${BROADCAST_SELECT} where b.id = $1 group by b.id, p.id`, [id]);
  return r ? publicBroadcast(r) : null;
}

export async function listBroadcasts(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const rows = await ctx.svc.db.query<BroadcastRow>(`${BROADCAST_SELECT} group by b.id, p.id order by b.created_at desc limit 50`);
  return json({ broadcasts: rows.map(publicBroadcast) });
}
