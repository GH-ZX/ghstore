/** Product reviews: only customers who received the product, one each, staff can hide; stars in the catalogue and for search engines. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productHead, productMeta } from "../src/index";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const base = 870_000_000 + (Date.now() % 1_000_000);

let slug = "";
let buyer = "";
let other = "";
let owner = "";

beforeAll(async () => {
  slug = `rev-${run}`;
  const p = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active)
     values ($1, (select id from app.categories where slug = 'games'), 'لعبة', 'Review Game', 'code', true) returning id`,
    [slug],
  ))[0]!;
  const o = (await db.query<{ id: string }>(`insert into app.offers (product_id, name_ar, name_en, price_cents) values ($1, 'باقة', 'Pack', 150) returning id`, [p.id]))[0]!;
  owner = await h.login(900001, "Owner");
  buyer = await h.login(base + 1, "Ahmad Khalil");
  other = await h.login(base + 2, "Sami");
  const buyerId = (await h.call("GET", "/api/me", { token: buyer })).data.user.id as string;
  await db.query(
    `insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, total_cents, status, channel, idempotency_key)
     values ($1, $2, $3, 1, 150, 150, 'delivered', 'miniapp', $4)`,
    [buyerId, o.id, p.id, `rev-order-${run}`],
  );
});

afterAll(async () => {
  await conn.close();
});

describe("reviews", () => {
  it("only lets a customer who received the product rate it", async () => {
    const no = await h.call("PUT", `/api/products/${slug}/review`, { token: other, body: { rating: 5 } });
    expect(no.status).toBe(403);
    const anon = await h.call("GET", `/api/products/${slug}/reviews`);
    expect(anon.data).toMatchObject({ canReview: false, mine: null, summary: { count: 0 } });
    expect((await h.call("GET", `/api/products/${slug}/reviews`, { token: buyer })).data.canReview).toBe(true);
  });

  it("keeps one review per customer, which they can change", async () => {
    expect((await h.call("PUT", `/api/products/${slug}/review`, { token: buyer, body: { rating: 0 } })).status).toBe(400);
    expect((await h.call("PUT", `/api/products/${slug}/review`, { token: buyer, body: { rating: 4, comment: "  Fast   delivery " } })).status).toBe(200);
    expect((await h.call("PUT", `/api/products/${slug}/review`, { token: buyer, body: { rating: 5, comment: "Fast delivery" } })).status).toBe(200);
    const r = await h.call("GET", `/api/products/${slug}/reviews`, { token: buyer });
    expect(r.data.summary).toMatchObject({ average: 5, count: 1, stars: [1, 0, 0, 0, 0] });
    expect(r.data.mine).toMatchObject({ rating: 5, comment: "Fast delivery", hidden: false });
    // Only the first name is shown.
    expect(r.data.reviews[0]).toMatchObject({ name: "Ahmad", rating: 5, mine: true });
    const cat = await h.call("GET", "/api/catalog");
    expect(cat.data.products.find((p: { slug: string }) => p.slug === slug)?.rating).toEqual({ average: 5, count: 1 });
  });

  it("gives search engines the stars and the review", async () => {
    const meta = await productMeta({ db }, slug);
    expect(meta?.rating).toEqual({ average: 5, count: 1 });
    const head = productHead(meta!, { baseUrl: "https://gh-store.me", storeName: "GH Store", locale: "en", defaultLocale: "ar" });
    const product = head.jsonLd![0] as Record<string, any>;
    expect(product.aggregateRating).toMatchObject({ ratingValue: 5, reviewCount: 1 });
    expect(product.review[0]).toMatchObject({ reviewBody: "Fast delivery", author: { name: "Ahmad" } });
  });

  it("lets staff hide a review, and the customer remove theirs", async () => {
    const list = await h.call("GET", "/api/admin/reviews", { token: owner });
    const id = (list.data.reviews as { id: string; slug: string }[]).find((r) => r.slug === slug)!.id;
    expect((await h.call("PATCH", `/api/admin/reviews/${id}`, { token: other, body: { status: "hidden" } })).status).toBe(403);
    expect((await h.call("PATCH", `/api/admin/reviews/${id}`, { token: owner, body: { status: "hidden" } })).status).toBe(200);
    const after = await h.call("GET", `/api/products/${slug}/reviews`, { token: buyer });
    expect(after.data.summary.count).toBe(0);
    expect(after.data.mine.hidden).toBe(true);
    expect((await h.call("DELETE", `/api/products/${slug}/review`, { token: buyer })).status).toBe(200);
    expect((await h.call("GET", `/api/products/${slug}/reviews`, { token: buyer })).data.mine).toBeNull();
  });
});
