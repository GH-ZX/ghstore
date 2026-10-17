/**
 * Favourites and "tell me when it's back".
 *
 * GET    /api/favorites                 the customer's saved products, and the sold-out packages they wait for
 * PUT    /api/favorites/:productId      save a product
 * DELETE /api/favorites/:productId      forget it
 * PUT    /api/stock-alerts/:offerId     tell me when this sold-out package is back
 * DELETE /api/stock-alerts/:offerId     never mind
 *
 * A package is sold out when its supplier has none (paused "supplier_unavailable")
 * or, sold from the store's own stock, no code is left. When it is on sale again
 * (the price check finds stock, the owner adds codes or lifts a pause), everyone
 * waiting gets one Telegram message (`back_in_stock`) and the request is done.
 */
import { queueBackInStockPosts } from "./channel";
import type { Ctx, Services } from "./context";
import { n } from "./db";
import { requireUser } from "./guard";
import { ApiError, json, uuid } from "./http";
import { ON_SALE, SOLD_OUT } from "./sql-fragments";

const MAX_FAVORITES = 200;
const MAX_ALERTS = 50;

export async function listFavorites(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const products = await ctx.svc.db.query<{
    id: string; slug: string; name_ar: string; name_en: string; image_url: string | null; category: string; from_cents: string | number | null;
  }>(
    `select p.id, p.slug, p.name_ar, p.name_en, p.image_url, c.slug as category,
            (select min(o.price_cents) from app.offers o
              where o.product_id = p.id and ${ON_SALE}) as from_cents
       from app.favorites f join app.products p on p.id = f.product_id join app.categories c on c.id = p.category_id
      where f.user_id = $1 and p.active and c.active
      order by f.created_at desc`,
    [user.id],
  );
  const alerts = await ctx.svc.db.query<{ offer_id: string }>(`select offer_id from app.stock_alerts where user_id = $1`, [user.id]);
  return json({
    productIds: products.map((p) => p.id),
    offerIds: alerts.map((a) => a.offer_id),
    products: products.map((p) => ({
      id: p.id, slug: p.slug, nameAr: p.name_ar, nameEn: p.name_en, imageUrl: p.image_url, category: p.category,
      // null: nothing on sale right now (sold out).
      fromCents: p.from_cents === null ? null : n(p.from_cents),
    })),
  });
}

export async function addFavorite(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const productId = uuid(ctx.params.productId);
  const count = await ctx.svc.db.query<{ c: string | number }>(`select count(*) as c from app.favorites where user_id = $1`, [user.id]);
  if (n(count[0]?.c) >= MAX_FAVORITES) throw new ApiError("rate_limited");
  const rows = await ctx.svc.db.query(
    `insert into app.favorites (user_id, product_id)
     select $1, p.id from app.products p where p.id = $2 and p.active
     on conflict do nothing returning product_id`,
    [user.id, productId],
  );
  if (!rows.length) {
    const exists = await ctx.svc.db.query(`select 1 from app.products where id = $1 and active`, [productId]);
    if (!exists.length) throw new ApiError("not_found");
  }
  return json({ ok: true });
}

export async function removeFavorite(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  await ctx.svc.db.query(`delete from app.favorites where user_id = $1 and product_id = $2`, [user.id, uuid(ctx.params.productId)]);
  return json({ ok: true });
}

export async function addStockAlert(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const offerId = uuid(ctx.params.offerId);
  // Only for a package that is sold out right now (an available one can simply be bought).
  const soldOut = await ctx.svc.db.query<{ sold_out: boolean }>(
    `select ${SOLD_OUT} as sold_out from app.offers o join app.products p on p.id = o.product_id
      where o.id = $1 and o.active and p.active and (o.paused_reason is null or o.paused_reason = 'supplier_unavailable')`,
    [offerId],
  );
  if (!soldOut.length) throw new ApiError("not_found");
  if (!soldOut[0]!.sold_out) throw new ApiError("bad_state");
  const count = await ctx.svc.db.query<{ c: string | number }>(`select count(*) as c from app.stock_alerts where user_id = $1`, [user.id]);
  if (n(count[0]?.c) >= MAX_ALERTS) throw new ApiError("rate_limited");
  await ctx.svc.db.query(`insert into app.stock_alerts (user_id, offer_id) values ($1, $2) on conflict do nothing`, [user.id, offerId]);
  return json({ ok: true });
}

export async function removeStockAlert(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  await ctx.svc.db.query(`delete from app.stock_alerts where user_id = $1 and offer_id = $2`, [user.id, uuid(ctx.params.offerId)]);
  return json({ ok: true });
}

/**
 * Packages that may be back on sale: tell everyone waiting for one that is
 * buyable now (one message each), and forget their requests. Returns how many
 * messages were queued.
 */
export async function notifyBackInStock(svc: Pick<Services, "db">, offerIds: string[]): Promise<number> {
  if (!offerIds.length) return 0;
  // The store's channel hears about it too (Admin → Broadcast → Channel posts).
  await queueBackInStockPosts(svc.db, offerIds);
  const rows = await svc.db.query<{ user_id: string }>(
    `with back as (
       select o.id, o.name_ar, o.name_en, p.slug, p.name_ar as product_ar, p.name_en as product_en
         from app.offers o join app.products p on p.id = o.product_id
        where o.id = any(string_to_array($1::text, ',')::uuid[]) and p.active and ${ON_SALE}
          and not ${SOLD_OUT}
     ), gone as (
       delete from app.stock_alerts a using back where a.offer_id = back.id
       returning a.user_id, back.slug, back.product_ar, back.product_en, back.name_ar, back.name_en
     )
     insert into app.outbox (user_id, template, data)
     select user_id, 'back_in_stock',
            jsonb_build_object('slug', slug, 'name_ar', product_ar, 'name_en', product_en, 'offer_ar', name_ar, 'offer_en', name_en)
       from gone
     returning user_id`,
    [offerIds.join(",")],
  );
  return rows.length;
}
