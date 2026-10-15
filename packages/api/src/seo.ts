/**
 * Link previews and search engines for a single-page app: the Worker answers
 * /p/<slug> with the normal index.html plus the product's title, description,
 * picture and price (Open Graph, Twitter card, JSON-LD), and serves
 * /sitemap.xml and /robots.txt. Customers still get the same app.
 */
import { formatUsd } from "@store/core";
import type { Services } from "./context";
import { n, one } from "./db";

export interface ProductMeta {
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  imageUrl: string | null;
  minCents: number | null;
  maxCents: number | null;
  offers: number;
}

export const PRODUCT_PATH = /^\/p\/([a-z0-9-]{1,80})\/?$/;

/** A sellable product's public details, or null (unknown or not on sale). */
export async function productMeta(svc: Pick<Services, "db">, slug: string): Promise<ProductMeta | null> {
  const r = await one<{
    slug: string; name_ar: string; name_en: string; description_ar: string; description_en: string; image_url: string | null;
    min_cents: string | number | null; max_cents: string | number | null; offers: string | number;
  }>(
    svc.db,
    `select p.slug, p.name_ar, p.name_en, p.description_ar, p.description_en, p.image_url,
            min(o.price_cents) as min_cents, max(o.price_cents) as max_cents, count(o.id) as offers
       from app.products p
       left join app.offers o on o.product_id = p.id and o.active and o.paused_reason is null
      where p.slug = $1 and p.active
      group by p.id`,
    [slug],
  );
  if (!r) return null;
  return {
    slug: r.slug, nameAr: r.name_ar, nameEn: r.name_en, descriptionAr: r.description_ar, descriptionEn: r.description_en,
    imageUrl: r.image_url && /^https:\/\//.test(r.image_url) ? r.image_url : null,
    minCents: r.min_cents === null ? null : n(r.min_cents),
    maxCents: r.max_cents === null ? null : n(r.max_cents),
    offers: n(r.offers),
  };
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

function plain(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * index.html with the product's head tags. `locale` is the store's default
 * language; the other language's name is added to the description.
 */
export function renderProductPage(
  indexHtml: string,
  meta: ProductMeta,
  opts: { baseUrl: string; storeName: string; locale: "ar" | "en" },
): string {
  const ar = opts.locale === "ar";
  const name = (ar ? meta.nameAr || meta.nameEn : meta.nameEn || meta.nameAr).trim();
  const other = (ar ? meta.nameEn : meta.nameAr).trim();
  const url = `${opts.baseUrl}/p/${meta.slug}`;
  const image = meta.imageUrl ?? `${opts.baseUrl}/icon-512.png`;
  const price = meta.minCents === null ? "" : ar ? `من ${formatUsd(meta.minCents)}` : `From ${formatUsd(meta.minCents)}`;
  const instant = ar ? "تسليم فوري" : "Instant delivery";
  const desc = plain(ar ? meta.descriptionAr || meta.descriptionEn : meta.descriptionEn || meta.descriptionAr, 160);
  const description = plain([price, instant, other && other !== name ? other : "", desc].filter(Boolean).join(" · "), 200);
  const title = `${name} | ${opts.storeName}`;

  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    ...(other && other !== name ? { alternateName: other } : {}),
    image,
    url,
    ...(desc ? { description: desc } : {}),
    brand: { "@type": "Brand", name: opts.storeName },
    ...(meta.minCents !== null && meta.maxCents !== null
      ? {
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "USD",
            lowPrice: (meta.minCents / 100).toFixed(2),
            highPrice: (meta.maxCents / 100).toFixed(2),
            offerCount: meta.offers,
            availability: meta.offers > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          },
        }
      : {}),
  };
  // JSON inside <script> must not be able to close the tag.
  const ldJson = JSON.stringify(ld).replace(/</g, "\\u003c");

  const tags = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="${escapeHtml(opts.storeName)}">`,
    `<meta property="og:title" content="${escapeHtml(name)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${ldJson}</script>`,
  ].join("\n");

  // Replacer functions, never replacement strings: "$&" or "$'" in a product's
  // text must stay text, not splice parts of the page back in.
  return indexHtml
    // The template's own site-wide preview tags make way for the product's.
    .replace(/<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>\n?/g, () => "")
    .replace(/<link rel="canonical"[^>]*>\n?/g, () => "")
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escapeHtml(description)}">`)
    .replace("</head>", () => `${tags}\n</head>`);
}

/** Every product on sale, for search engines. */
export async function sitemapXml(svc: Pick<Services, "db">, baseUrl: string): Promise<string> {
  const rows = await svc.db.query<{ slug: string; updated_at: string | Date }>(
    `select p.slug, p.updated_at from app.products p
      where p.active and exists (select 1 from app.offers o where o.product_id = p.id and o.active and o.paused_reason is null)
      order by p.sort, p.slug limit 5000`,
  );
  const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);
  const urls = [
    `<url><loc>${escapeHtml(`${baseUrl}/`)}</loc><changefreq>daily</changefreq></url>`,
    ...rows.map((r) => `<url><loc>${escapeHtml(`${baseUrl}/p/${r.slug}`)}</loc><lastmod>${day(r.updated_at)}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function robotsTxt(baseUrl: string): string {
  return ["User-agent: *", "Disallow: /admin", "Disallow: /api/", "Disallow: /tg", "Disallow: /login", "", `Sitemap: ${baseUrl}/sitemap.xml`, ""].join("\n");
}
