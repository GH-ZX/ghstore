/**
 * Public catalog. Only active products with at least one sellable offer appear.
 * Supplier names and costs are never exposed.
 */
import type { InputField } from "@store/core";
import type { Ctx } from "./context";
import { n, one } from "./db";
import { ApiError, json } from "./http";
import { matchesQuery } from "./search";

interface ProductRow {
  id: string;
  slug: string;
  category_slug: string;
  name_ar: string;
  name_en: string;
  kind: string;
  image_url: string | null;
  featured: boolean;
  search_terms: string;
  min_price_cents: string | number;
  offer_count: string | number;
}

export async function listCatalog(ctx: Ctx): Promise<Response> {
  const db = ctx.svc.db;
  const categories = await db.query<{ slug: string; name_ar: string; name_en: string }>(
    `select slug, name_ar, name_en from app.categories where active order by sort, slug`,
  );
  const rows = await db.query<ProductRow>(
    `select p.id, p.slug, c.slug as category_slug, p.name_ar, p.name_en, p.kind, p.image_url, p.featured, p.search_terms,
            min(o.price_cents) as min_price_cents, count(o.id) as offer_count
       from app.products p
       join app.categories c on c.id = p.category_id and c.active
       join app.offers o on o.product_id = p.id and o.active and o.paused_reason is null
      where p.active
      group by p.id, c.slug
      order by p.featured desc, p.sort, p.name_en`,
  );
  const q = ctx.url.searchParams.get("q")?.slice(0, 80) ?? "";
  const cat = ctx.url.searchParams.get("category") ?? "";
  const products = rows
    .filter((r) => !cat || r.category_slug === cat)
    .filter((r) => !q || matchesQuery(`${r.name_ar} ${r.name_en} ${r.slug} ${r.search_terms}`, q))
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      category: r.category_slug,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      kind: r.kind,
      imageUrl: r.image_url,
      featured: r.featured,
      fromCents: n(r.min_price_cents),
      packages: n(r.offer_count),
    }));
  return json(
    { categories: categories.map((c) => ({ slug: c.slug, nameAr: c.name_ar, nameEn: c.name_en })), products },
    { headers: { "cache-control": q ? "no-store" : "public, max-age=30" } },
  );
}

export async function getProduct(ctx: Ctx): Promise<Response> {
  const slug = ctx.params.slug ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new ApiError("not_found");
  const p = await one<{
    id: string; slug: string; name_ar: string; name_en: string; kind: string; image_url: string | null;
    description_ar: string; description_en: string; instructions_ar: string; instructions_en: string;
    warranty_ar: string; warranty_en: string; category_slug: string;
  }>(
    ctx.svc.db,
    `select p.id, p.slug, p.name_ar, p.name_en, p.kind, p.image_url, p.description_ar, p.description_en,
            p.instructions_ar, p.instructions_en, p.warranty_ar, p.warranty_en, c.slug as category_slug
       from app.products p join app.categories c on c.id = p.category_id
      where p.slug = $1 and p.active and c.active`,
    [slug],
  );
  if (!p) throw new ApiError("not_found");
  const offers = await ctx.svc.db.query<{
    id: string; name_ar: string; name_en: string; price_cents: string | number; input_fields: InputField[]; max_quantity: number;
  }>(
    `select id, name_ar, name_en, price_cents, input_fields, max_quantity
       from app.offers where product_id = $1 and active and paused_reason is null order by sort, price_cents`,
    [p.id],
  );
  if (!offers.length) throw new ApiError("not_found");
  return json({
    product: {
      id: p.id, slug: p.slug, category: p.category_slug, kind: p.kind, imageUrl: p.image_url,
      nameAr: p.name_ar, nameEn: p.name_en, descriptionAr: p.description_ar, descriptionEn: p.description_en,
      instructionsAr: p.instructions_ar, instructionsEn: p.instructions_en, warrantyAr: p.warranty_ar, warrantyEn: p.warranty_en,
    },
    offers: offers.map((o) => ({
      id: o.id, nameAr: o.name_ar, nameEn: o.name_en, priceCents: n(o.price_cents),
      fields: o.input_fields, maxQuantity: o.max_quantity,
    })),
  });
}
