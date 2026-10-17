/**
 * Product reviews. A customer who received a product (a delivered order) rates
 * it from 1 to 5 stars, with an optional comment; one review per customer and
 * product, which they can change or remove. Staff can hide a review (Admin →
 * Reviews). Reviews show on the product, as stars on its card, and in the
 * product's structured data for search engines.
 */
import { optionalUser, requireStaff, requireUser } from "./auth";
import type { Ctx } from "./context";
import { n, one, type Db } from "./db";
import { ApiError, json, readJson, uuid } from "./http";

const PAGE = 10;

export interface RatingSummary {
  average: number;
  count: number;
}

/** Visible reviews per product (or for one product): average and count, for the store's cards. */
export async function ratingsByProduct(db: Db, only?: string): Promise<Map<string, RatingSummary>> {
  const rows = await db.query<{ product_id: string; average: string | number; count: string | number }>(
    `select product_id, avg(rating) as average, count(*) as count from app.reviews
      where status = 'visible' and ($1::uuid is null or product_id = $1) group by product_id`,
    [only ?? null],
  );
  return new Map(rows.map((r) => [r.product_id, { average: Math.round(Number(r.average) * 10) / 10, count: n(r.count) }]));
}

/** "Ahmad K." → "Ahmad": only a first name is shown with a review. */
function shownName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.slice(0, 24);
}

async function productId(db: Db, slug: string): Promise<string> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new ApiError("not_found");
  const p = await one<{ id: string }>(db, `select id from app.products where slug = $1 and active`, [slug]);
  if (!p) throw new ApiError("not_found");
  return p.id;
}

/** The customer received this product at least once. */
async function received(db: Db, userId: string, product: string): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    db,
    `select exists (select 1 from app.orders where user_id = $1 and product_id = $2 and status = 'delivered') as ok`,
    [userId, product],
  );
  return !!r?.ok;
}

/** GET /api/products/:slug/reviews?before=<iso> — the summary, a page of reviews, and the visitor's own. */
export async function listReviews(ctx: Ctx): Promise<Response> {
  const db = ctx.svc.db;
  const product = await productId(db, ctx.params.slug ?? "");
  const me = await optionalUser(ctx);
  const beforeRaw = ctx.url.searchParams.get("before");
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw).toISOString() : null;
  const [summary, stars, rows, mine, canReview] = await Promise.all([
    one<{ average: string | number | null; count: string | number }>(
      db,
      `select avg(rating) as average, count(*) as count from app.reviews where product_id = $1 and status = 'visible'`,
      [product],
    ),
    db.query<{ rating: number; count: string | number }>(
      `select rating, count(*) as count from app.reviews where product_id = $1 and status = 'visible' group by rating`,
      [product],
    ),
    db.query<{ id: string; rating: number; comment: string; created_at: string | Date; display_name: string; user_id: string }>(
      `select r.id, r.rating, r.comment, r.created_at, u.display_name, r.user_id
         from app.reviews r join app.users u on u.id = r.user_id
        where r.product_id = $1 and r.status = 'visible' and ($2::timestamptz is null or r.created_at < $2)
        order by r.created_at desc
        limit ${PAGE + 1}`,
      [product, before],
    ),
    me ? one<{ rating: number; comment: string; status: string }>(db, `select rating, comment, status from app.reviews where product_id = $1 and user_id = $2`, [product, me.id]) : null,
    me ? received(db, me.id, product) : false,
  ]);
  return json({
    summary: {
      average: summary?.average === null || summary?.average === undefined ? 0 : Math.round(Number(summary.average) * 10) / 10,
      count: n(summary?.count),
      stars: [5, 4, 3, 2, 1].map((s) => n(stars.find((x) => Number(x.rating) === s)?.count)),
    },
    reviews: rows.slice(0, PAGE).map((r) => ({
      id: r.id,
      name: shownName(r.display_name),
      rating: Number(r.rating),
      comment: r.comment,
      createdAt: new Date(r.created_at).toISOString(),
      mine: r.user_id === me?.id,
    })),
    more: rows.length > PAGE,
    mine: mine ? { rating: Number(mine.rating), comment: mine.comment, hidden: mine.status === "hidden" } : null,
    canReview: !!canReview,
  });
}

/** PUT /api/products/:slug/review { rating, comment } — rate a product you received (again to change it). */
export async function saveReview(ctx: Ctx): Promise<Response> {
  const me = await requireUser(ctx);
  const db = ctx.svc.db;
  const product = await productId(db, ctx.params.slug ?? "");
  if (!(await received(db, me.id, product))) throw new ApiError("not_allowed", "not_received");
  const body = await readJson(ctx.req);
  const rating = body.rating;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) throw new ApiError("invalid_input", "rating");
  const comment = typeof body.comment === "string" ? body.comment.replace(/\s+/g, " ").trim() : "";
  if (comment.length > 600) throw new ApiError("invalid_input", "comment");
  // A hidden review stays hidden when it is edited.
  await db.query(
    `insert into app.reviews (product_id, user_id, rating, comment) values ($1, $2, $3, $4)
     on conflict (product_id, user_id) do update set rating = excluded.rating, comment = excluded.comment`,
    [product, me.id, rating, comment],
  );
  return json({ ok: true });
}

/** DELETE /api/products/:slug/review — remove your review. */
export async function deleteReview(ctx: Ctx): Promise<Response> {
  const me = await requireUser(ctx);
  const product = await productId(ctx.svc.db, ctx.params.slug ?? "");
  await ctx.svc.db.query(`delete from app.reviews where product_id = $1 and user_id = $2`, [product, me.id]);
  return json({ ok: true });
}

// ─────────────────────────────────────────────────────────────── admin

/** GET /api/admin/reviews?status=visible|hidden — the latest reviews. */
export async function adminReviews(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "support");
  const status = ctx.url.searchParams.get("status");
  const rows = await ctx.svc.db.query<Record<string, unknown>>(
    `select r.id, r.rating, r.comment, r.status, r.created_at, r.updated_at, u.id as user_id, u.display_name,
            p.slug, p.name_ar, p.name_en
       from app.reviews r join app.users u on u.id = r.user_id join app.products p on p.id = r.product_id
      where ($1::text is null or r.status = $1)
      order by r.created_at desc limit 300`,
    [status === "visible" || status === "hidden" ? status : null],
  );
  return json({ reviews: rows });
}

/** PATCH /api/admin/reviews/:id { status } — hide or show a review. */
export async function setReviewStatus(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "support");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  if (body.status !== "visible" && body.status !== "hidden") throw new ApiError("invalid_input", "status");
  const rows = await ctx.svc.db.query(`update app.reviews set status = $2 where id = $1 returning id`, [id, body.status]);
  if (!rows.length) throw new ApiError("not_found");
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, 'review.status', 'review', $2, $3::text::jsonb)`,
    [staff.id, id, JSON.stringify({ status: body.status })],
  );
  return json({ ok: true });
}

/** DELETE /api/admin/reviews/:id — remove a review (spam, abuse). */
export async function removeReview(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  await ctx.svc.db.query(`delete from app.reviews where id = $1`, [id]);
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, 'review.delete', 'review', $2, '{}'::jsonb)`,
    [staff.id, id],
  );
  return json({ ok: true });
}
