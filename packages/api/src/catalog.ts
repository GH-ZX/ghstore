/**
 * Public catalog. Only active products with at least one sellable offer appear.
 * Supplier names and costs are never exposed.
 */
import { matchesQuery, type AfterField, type InputField } from "@store/core";
import type { Ctx } from "./context";
import { n, one } from "./db";
import { liveBanners } from "./home";
import { showcaseSettings } from "./settings";
import { ApiError, json } from "./http";

interface ProductRow {
  id: string;
  slug: string;
  category_slug: string;
  name_ar: string;
  name_en: string;
  kind: string;
  delivery: string;
  badge: string | null;
  image_url: string | null;
  cover_url: string | null;
  featured: boolean;
  search_terms: string;
  min_price_cents: string | number;
  offer_count: string | number;
}

export async function listCatalog(ctx: Ctx): Promise<Response> {
  const db = ctx.svc.db;
  const categories = await db.query<{ slug: string; name_ar: string; name_en: string; icon: string | null }>(
    `select slug, name_ar, name_en, icon from app.categories where active order by sort, slug`,
  );
  const rows = await db.query<ProductRow>(
    `select p.id, p.slug, c.slug as category_slug, p.name_ar, p.name_en, p.kind, p.delivery, p.badge, p.image_url, p.cover_url, p.featured, p.search_terms,
            min(o.price_cents) as min_price_cents, count(o.id) as offer_count
       from app.products p
       join app.categories c on c.id = p.category_id and c.active
       join app.offers o on o.product_id = p.id and o.active and o.paused_reason is null
            -- a package whose supplier is switched off in Admin → Suppliers is not for sale
            and (o.supplier_id is null or exists (select 1 from app.suppliers s where s.id = o.supplier_id and s.enabled))
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
      coverUrl: r.cover_url,
      featured: r.featured,
      fromCents: n(r.min_price_cents),
      packages: n(r.offer_count),
      searchTerms: r.search_terms,
      // Delivered by the team, not instantly.
      byHand: r.delivery !== "auto",
      // The badge the owner chose for the card (none by default).
      badge: r.badge,
    }));
  const home = !q && !cat;
  const banners = home ? await liveBanners(db) : [];
  return json(
    {
      categories: categories.map((c) => ({ slug: c.slug, nameAr: c.name_ar, nameEn: c.name_en, icon: c.icon })),
      products,
      // The home page showcase (Admin → Home); empty when searching or filtering.
      banners,
      ...(home ? { showcase: await showcase(db, banners, products) } : {}),
    },
    { headers: { "cache-control": q ? "no-store" : "public, max-age=30" } },
  );
}

interface ShowcasePackage {
  id: string;
  nameAr: string;
  nameEn: string;
  priceCents: number;
}

/** A few packages to show on a slide: the cheapest, one from the middle and one near the top. */
export function pickPackages<T>(sorted: T[], max = 3): T[] {
  if (sorted.length <= max) return sorted;
  const picks = new Set<number>();
  for (let i = 0; i < max; i++) picks.add(Math.round((i * (sorted.length - 1)) / max));
  return [...picks].map((i) => sorted[i]!);
}

/**
 * The showcase's settings and, for its slides' products (the banners' products,
 * or the products it shows without banners), a few packages with prices for
 * slides in the "deal" look.
 */
async function showcase(db: Ctx["svc"]["db"], banners: Awaited<ReturnType<typeof liveBanners>>, products: { id: string; slug: string; featured: boolean; packages: number }[]) {
  const settings = await showcaseSettings(db);
  const deal = (look: string | null) => (look ?? settings.style) === "deal";
  const slugs = banners.length
    ? banners.flatMap((b) => (b.link?.type === "product" && deal(b.look) ? [b.link.value] : []))
    : deal(null)
      ? (products.some((p) => p.featured) ? products.filter((p) => p.featured) : [...products].sort((a, b) => b.packages - a.packages)).slice(0, 6).map((p) => p.slug)
      : [];
  const ids = products.filter((p) => slugs.includes(p.slug));
  const packages: Record<string, ShowcasePackage[]> = {};
  if (ids.length) {
    const rows = await db.query<{ product_id: string; id: string; name_ar: string; name_en: string; price_cents: string | number }>(
      `select o.product_id, o.id, o.name_ar, o.name_en, o.price_cents
         from app.offers o
        where o.product_id in (select jsonb_array_elements_text($1::text::jsonb)::uuid) and o.active and o.paused_reason is null
          and (o.supplier_id is null or exists (select 1 from app.suppliers s where s.id = o.supplier_id and s.enabled))
        order by o.price_cents, o.sort`,
      [JSON.stringify(ids.map((p) => p.id))],
    );
    for (const p of ids) {
      const list = rows.filter((r) => r.product_id === p.id).map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, priceCents: n(r.price_cents) }));
      packages[p.slug] = pickPackages(list, settings.dealPackages);
    }
  }
  return { ...settings, packages };
}

export async function getProduct(ctx: Ctx): Promise<Response> {
  const slug = ctx.params.slug ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new ApiError("not_found");
  const p = await one<{
    id: string; slug: string; name_ar: string; name_en: string; kind: string; image_url: string | null; cover_url: string | null;
    description_ar: string; description_en: string; instructions_ar: string; instructions_en: string;
    warranty_ar: string; warranty_en: string; category_slug: string; delivery: string; after_fields: AfterField[]; badge: string | null;
  }>(
    ctx.svc.db,
    `select p.id, p.slug, p.name_ar, p.name_en, p.kind, p.image_url, p.cover_url, p.description_ar, p.description_en,
            p.instructions_ar, p.instructions_en, p.warranty_ar, p.warranty_en, c.slug as category_slug, p.delivery, p.after_fields, p.badge
       from app.products p join app.categories c on c.id = p.category_id
      where p.slug = $1 and p.active and c.active`,
    [slug],
  );
  if (!p) throw new ApiError("not_found");
  const offers = await ctx.svc.db.query<{
    id: string; name_ar: string; name_en: string; price_cents: string | number; input_fields: InputField[]; max_quantity: number;
    warranty_ar: string | null; warranty_en: string | null; success_pct: string | number | null;
  }>(
    `select o.id, o.name_ar, o.name_en, o.price_cents, o.input_fields, o.max_quantity, o.warranty_ar, o.warranty_en, o.success_pct
       from app.offers o where o.product_id = $1 and o.active and o.paused_reason is null
        and (o.supplier_id is null or exists (select 1 from app.suppliers s where s.id = o.supplier_id and s.enabled))
      -- Virtual numbers: the countries whose numbers get their SMS most often first.
      order by case when $2 = 'sms' then -coalesce(o.success_pct, -1) end, o.sort, o.price_cents`,
    [p.id, p.kind],
  );
  if (!offers.length) throw new ApiError("not_found");
  return json({
    product: {
      id: p.id, slug: p.slug, category: p.category_slug, kind: p.kind, imageUrl: p.image_url, coverUrl: p.cover_url,
      nameAr: p.name_ar, nameEn: p.name_en, descriptionAr: p.description_ar, descriptionEn: p.description_en,
      instructionsAr: p.instructions_ar, instructionsEn: p.instructions_en, warrantyAr: p.warranty_ar, warrantyEn: p.warranty_en,
      // Delivered by a person (not instantly), and what the customer is asked after paying.
      byHand: p.delivery !== "auto",
      badge: p.badge,
      afterFields: (p.after_fields ?? []).map((f) => ({ key: f.key, type: f.type, labelEn: f.labelEn, labelAr: f.labelAr, required: f.required })),
    },
    offers: offers.map((o) => ({
      id: o.id, nameAr: o.name_ar, nameEn: o.name_en, priceCents: n(o.price_cents),
      fields: o.input_fields, maxQuantity: o.max_quantity, warrantyAr: o.warranty_ar, warrantyEn: o.warranty_en,
      successPct: o.success_pct === null ? null : Number(o.success_pct),
    })),
  });
}
