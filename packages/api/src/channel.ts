/**
 * Posts to the store's Telegram channel (Admin → Broadcast → Channel posts):
 * a new product, a package back in stock, a price drop. Events are queued in
 * app.channel_posts; the scheduled job sends one at a time, a few a day at
 * most, each with the product's picture, its price in both languages and a
 * button to open it in the Mini App. The store bot must be an admin of the
 * channel. Products on sale before this existed are not announced.
 */
import { store } from "@store/config";
import { formatUsd } from "@store/core";
import type { ApiEnv, Ctx, Services } from "./context";
import { n, one, type Db } from "./db";
import { requireStaff } from "./guard";
import { ApiError, json } from "./http";
import { botUsername, channelUrl, readSettings } from "./settings";
import { ON_SALE } from "./sql-fragments";

/** A public channel's @name, or a numeric chat id (-100…). */
export const CHANNEL_CHAT = /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{6,15})$/;
/** A price at least this much lower is announced. */
const DROP_RATIO = 0.9;
/** Pending posts older than this are dropped (old news). */
const STALE_DAYS = 2;

export interface ChannelSettings {
  chat: string | null;
  postNew: boolean;
  postBack: boolean;
  postDrops: boolean;
  maxPerDay: number;
}

export async function channelSettings(db: Db): Promise<ChannelSettings> {
  const s = await readSettings(db, ["channel.chat", "channel.post_new", "channel.post_back", "channel.post_drops", "channel.max_per_day"]);
  let chat = typeof s["channel.chat"] === "string" && CHANNEL_CHAT.test(s["channel.chat"]) ? s["channel.chat"] : null;
  // No chat set: the store's public channel (t.me/name) from Admin → Settings.
  if (!chat) {
    const url = await channelUrl(db);
    const name = url ? /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(url)?.[1] : null;
    chat = name ? `@${name}` : null;
  }
  const max = s["channel.max_per_day"];
  return {
    chat,
    postNew: s["channel.post_new"] === true,
    postBack: s["channel.post_back"] === true,
    postDrops: s["channel.post_drops"] === true,
    maxPerDay: typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 30 ? max : 6,
  };
}

/** Back in stock (called when packages go on sale again): one post per product a day at most. */
export async function queueBackInStockPosts(db: Db, offerIds: string[]): Promise<void> {
  if (!offerIds.length) return;
  await db.query(
    `insert into app.channel_posts (kind, product_id, data)
     select distinct 'back_in_stock', o.product_id, '{}'::jsonb from app.offers o
      where o.id = any(string_to_array($1::text, ',')::uuid[])
        and not exists (select 1 from app.channel_posts c where c.kind = 'back_in_stock' and c.product_id = o.product_id and c.created_at > now() - interval '1 day')
     on conflict do nothing`,
    [offerIds.join(",")],
  );
}

/** New products and price drops since the last run go into the queue. */
export async function queueChannelPosts(db: Db): Promise<void> {
  await db.query(
    `with fresh as (
       update app.products p set channel_posted_at = now()
        where p.channel_posted_at is null and p.active
          and exists (select 1 from app.offers o where o.product_id = p.id and ${ON_SALE})
        returning p.id)
     insert into app.channel_posts (kind, product_id) select 'new_product', id from fresh on conflict do nothing`,
  );
  await db.query(
    `insert into app.channel_posts (kind, product_id, data)
     select distinct on (o.product_id) 'price_drop', o.product_id,
            jsonb_build_object('offer_ar', o.name_ar, 'offer_en', o.name_en, 'old_cents', c.old_price_cents, 'new_cents', c.new_price_cents)
       from app.price_changes c join app.offers o on o.id = c.offer_id join app.products p on p.id = o.product_id
      where c.at > now() - interval '6 hours' and c.new_price_cents > 0 and c.new_price_cents <= c.old_price_cents * ${DROP_RATIO}
        and p.active and ${ON_SALE}
        and not exists (select 1 from app.channel_posts x where x.kind = 'price_drop' and x.product_id = o.product_id and x.created_at > now() - interval '3 days')
      order by o.product_id, (c.old_price_cents - c.new_price_cents) desc
     on conflict do nothing`,
  );
}

interface PostRow {
  id: string | number;
  kind: "new_product" | "back_in_stock" | "price_drop";
  data: Record<string, unknown>;
  slug: string;
  name_ar: string;
  name_en: string;
  image_url: string | null;
  cover_url: string | null;
  from_cents: string | number | null;
  active: boolean;
}

/** The post's text: Arabic, then English. */
export function postText(p: Pick<PostRow, "kind" | "data" | "name_ar" | "name_en" | "from_cents">): string {
  const from = p.from_cents === null ? "" : formatUsd(n(p.from_cents));
  if (p.kind === "price_drop") {
    const was = formatUsd(n(p.data.old_cents));
    const now = formatUsd(n(p.data.new_cents));
    return [
      `🔻 سعر أقل: ${p.name_ar} (${String(p.data.offer_ar ?? "")})`,
      `${was} ← ${now}`,
      "",
      `🔻 Price drop: ${p.name_en} (${String(p.data.offer_en ?? "")})`,
      `${was} → ${now}`,
    ].join("\n");
  }
  const [ar, en] = p.kind === "new_product" ? ["🆕 جديد في المتجر", "🆕 New in the store"] : ["✅ عاد إلى المتجر", "✅ Back in stock"];
  const lines = [`${ar}: ${p.name_ar}`];
  if (from) lines.push(`من ${from}`);
  lines.push("", `${en}: ${p.name_en}`);
  if (from) lines.push(`from ${from}`);
  return lines.join("\n");
}

async function sendPost(svc: Services, env: ApiEnv, chat: string, p: PostRow): Promise<void> {
  const bot = await botUsername(svc.db);
  const caption = postText(p);
  const reply_markup = {
    inline_keyboard: [
      [{ text: "افتح في تيليجرام · Open in Telegram", url: `https://t.me/${bot}?startapp=p_${p.slug}` }],
      [{ text: `${store.url.replace(/^https:\/\//, "")}`, url: `${env.PUBLIC_BASE_URL}/p/${p.slug}` }],
    ],
  };
  // Telegram shows JPEG/PNG/WebP pictures, not SVG logos.
  const photo = [p.cover_url, p.image_url].find((u) => u && /^https:\/\//.test(u) && !/\.svg(\?|$)/i.test(u)) ?? null;
  if (photo) await svc.telegram("sendPhoto", { chat_id: chat, photo, caption, reply_markup });
  else await svc.telegram("sendMessage", { chat_id: chat, text: caption, reply_markup, link_preview_options: { is_disabled: true } });
}

/** Send the oldest pending post, within the day's limit. Returns how many were sent (0 or 1). */
export async function sendChannelPosts(svc: Services, env: ApiEnv): Promise<number> {
  await svc.db.query(`update app.channel_posts set status = 'skipped', error = 'too old' where status = 'pending' and created_at < now() - make_interval(days => $1)`, [STALE_DAYS]);
  const cfg = await channelSettings(svc.db);
  const on = { new_product: cfg.postNew, back_in_stock: cfg.postBack, price_drop: cfg.postDrops };
  // Switched off kinds are dropped, not kept for later.
  await svc.db.query(
    `update app.channel_posts set status = 'skipped', error = 'off' where status = 'pending' and not (kind = any(string_to_array($1::text, ',')))`,
    [Object.entries(on).filter(([, v]) => v).map(([k]) => k).join(",") || "-"],
  );
  if (!cfg.chat) return 0;
  const today = await one<{ c: string | number }>(svc.db, `select count(*) as c from app.channel_posts where status = 'sent' and sent_at > now() - interval '1 day'`);
  if (n(today?.c) >= cfg.maxPerDay) return 0;
  const p = await one<PostRow>(
    svc.db,
    `update app.channel_posts c set attempts = attempts + 1
      where c.id = (select id from app.channel_posts where status = 'pending' order by created_at limit 1 for update skip locked)
     returning c.id, c.kind, c.data,
       (select slug from app.products where id = c.product_id) as slug,
       (select name_ar from app.products where id = c.product_id) as name_ar,
       (select name_en from app.products where id = c.product_id) as name_en,
       (select image_url from app.products where id = c.product_id) as image_url,
       (select cover_url from app.products where id = c.product_id) as cover_url,
       (select active from app.products where id = c.product_id) as active,
       (select min(o.price_cents) from app.offers o where o.product_id = c.product_id and ${ON_SALE}) as from_cents`,
  );
  if (!p) return 0;
  if (!p.active || p.from_cents === null) {
    await svc.db.query(`update app.channel_posts set status = 'skipped', error = 'not on sale' where id = $1`, [p.id]);
    return 0;
  }
  try {
    await sendPost(svc, env, cfg.chat, p);
    await svc.db.query(`update app.channel_posts set status = 'sent', sent_at = now(), error = null where id = $1`, [p.id]);
    return 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 300) : "error";
    await svc.db.query(`update app.channel_posts set status = case when attempts >= 3 then 'failed' else 'pending' end, error = $2 where id = $1`, [p.id, msg]);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────── admin

/** GET /api/admin/channel — the channel the posts go to and the latest posts. */
export async function adminChannel(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const cfg = await channelSettings(ctx.svc.db);
  const posts = await ctx.svc.db.query(
    `select c.id, c.kind, c.status, c.error, c.created_at, c.sent_at, p.name_ar, p.name_en, p.slug
       from app.channel_posts c join app.products p on p.id = c.product_id order by c.created_at desc limit 20`,
  );
  return json({ chat: cfg.chat, posts });
}

/** POST /api/admin/channel/test — post a product (the most sold lately) to the channel now. */
export async function testChannelPost(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const cfg = await channelSettings(ctx.svc.db);
  if (!cfg.chat) throw new ApiError("bad_state", "channel.chat");
  const p = await one<PostRow>(
    ctx.svc.db,
    `select 0 as id, 'new_product' as kind, '{}'::jsonb as data, p.slug, p.name_ar, p.name_en, p.image_url, p.cover_url, p.active,
            (select min(o.price_cents) from app.offers o where o.product_id = p.id and ${ON_SALE}) as from_cents
       from app.products p
      where p.active and exists (select 1 from app.offers o where o.product_id = p.id and ${ON_SALE})
      order by (select count(*) from app.orders r where r.product_id = p.id and r.created_at > now() - interval '30 days') desc, p.featured desc
      limit 1`,
  );
  if (!p) throw new ApiError("not_found");
  try {
    await sendPost(ctx.svc, ctx.env, cfg.chat, p);
  } catch (err) {
    // Telegram's reason (not an admin of the channel, chat not found…) helps the owner fix it.
    return json({ ok: false, error: err instanceof Error ? err.message.slice(0, 300) : "error" });
  }
  return json({ ok: true, chat: cfg.chat });
}
