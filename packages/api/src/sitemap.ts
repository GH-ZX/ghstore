/**
 * The files crawlers ask for: /sitemap.xml (every page on show, in both
 * languages), /llms.txt (the store in Markdown for AI assistants) and
 * /robots.txt. The pages themselves are seo.ts.
 */
import { store } from "@store/config";
import { formatUsd } from "@store/core";
import type { Services } from "./context";
import { n } from "./db";
import { allPages } from "./pages";
import { escapeHtml, localUrl, seoSettings, type Locale, type PageOpts, type ProductCardRow } from "./seo";
import { ON_SALE } from "./sql-fragments";

/** Every page on show, each language version with its alternates. */
export async function sitemapXml(svc: Pick<Services, "db">, baseUrl: string, defaultLocale: Locale = store.defaultLocale): Promise<string> {
  const [products, cats, pages] = await Promise.all([
    svc.db.query<{ slug: string; updated_at: string | Date }>(
      `select p.slug, p.updated_at from app.products p
        where p.active and exists (select 1 from app.offers o where o.product_id = p.id and ${ON_SALE})
        order by p.sort, p.slug limit 5000`,
    ),
    svc.db.query<{ slug: string }>(
      `select c.slug from app.categories c
        where c.active and exists (select 1 from app.products p join app.offers o on o.product_id = p.id and ${ON_SALE} where p.category_id = c.id and p.active)
        order by c.sort, c.slug`,
    ),
    allPages(svc.db),
  ]);
  const o: PageOpts = { baseUrl, storeName: store.name, locale: defaultLocale, defaultLocale };
  const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);
  const entry = (path: string, extra: string) => {
    const links = [
      ...(["ar", "en"] as const).map((x) => `<xhtml:link rel="alternate" hreflang="${x}" href="${escapeHtml(localUrl(o, path, x))}"/>`),
      `<xhtml:link rel="alternate" hreflang="x-default" href="${escapeHtml(localUrl(o, path, defaultLocale))}"/>`,
    ].join("");
    return (defaultLocale === "ar" ? (["ar", "en"] as const) : (["en", "ar"] as const))
      .map((x) => `<url><loc>${escapeHtml(localUrl(o, path, x))}</loc>${extra}${links}</url>`)
      .join("\n");
  };
  const urls = [
    entry("/", "<changefreq>daily</changefreq>"),
    ...cats.map((c) => entry(`/c/${c.slug}`, "<changefreq>daily</changefreq>")),
    ...products.map((r) => entry(`/p/${r.slug}`, `<lastmod>${day(r.updated_at)}</lastmod>`)),
    ...pages.filter((p) => p.published).map((p) => entry(`/legal/${p.slug}`, `<lastmod>${day(p.updatedAt)}</lastmod>`)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

/**
 * /llms.txt (https://llmstxt.org): the store in Markdown for AI assistants and
 * agents: what it sells, its categories and products with prices, each linking
 * to its page (the English version; the Arabic one is the same address without
 * ?lang=en), and its policies. Null while the owner keeps the store out of
 * search engines (Admin → SEO & pages).
 */
export async function llmsTxt(svc: Pick<Services, "db">, baseUrl: string, defaultLocale: Locale = store.defaultLocale): Promise<string | null> {
  const [cats, products, pages, seo] = await Promise.all([
    svc.db.query<{ slug: string; name_ar: string; name_en: string; products: string | number }>(
      `select c.slug, c.name_ar, c.name_en, count(distinct p.id) as products from app.categories c
         join app.products p on p.category_id = c.id and p.active
         join app.offers o on o.product_id = p.id and ${ON_SALE}
        where c.active group by c.id order by c.sort, c.slug`,
    ),
    svc.db.query<ProductCardRow & { category: string }>(
      `select p.slug, p.name_ar, p.name_en, c.slug as category, min(o.price_cents) as from_cents
         from app.products p join app.categories c on c.id = p.category_id and c.active
         join app.offers o on o.product_id = p.id and ${ON_SALE}
        where p.active group by p.id, c.id
        order by c.sort, c.slug, p.featured desc, p.sort, p.name_en limit 1000`,
    ),
    allPages(svc.db),
    seoSettings(svc.db),
  ]);
  if (!seo.indexing) return null;
  const o: PageOpts = { baseUrl, storeName: store.name, locale: "en", defaultLocale };
  const url = (path: string) => localUrl(o, path, "en");
  // Markdown link text: no brackets or line breaks from the owner's names.
  const md = (s: string) => s.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const both = (en: string, ar: string) => (ar && ar.trim() !== en.trim() ? `${md(en || ar)} (${md(ar)})` : md(en || ar));
  const lines = [
    `# ${store.name}`,
    "",
    `> ${md(seo.descriptionEn ?? store.tagline.en)}`,
    "",
    `${store.name} is an online store for digital goods: game top-ups, gift cards and vouchers, app subscriptions and virtual phone numbers. ` +
      "Prices are in US dollars; customers pay from a wallet they top up, and most orders are delivered automatically within seconds. " +
      `The site is in Arabic (${localUrl(o, "/", "ar")}) and English (${url("/")}).`,
    "",
    `${md(seo.descriptionAr ?? store.tagline.ar)}`,
    "",
    "## Categories",
    "",
    ...cats.map((c) => `- [${both(c.name_en, c.name_ar)}](${url(`/c/${c.slug}`)}): ${n(c.products)} ${n(c.products) === 1 ? "product" : "products"}`),
  ];
  for (const c of cats) {
    const items = products.filter((p) => p.category === c.slug);
    if (!items.length) continue;
    lines.push("", `## ${md(c.name_en || c.name_ar)}`, "");
    for (const p of items) lines.push(`- [${both(p.name_en, p.name_ar)}](${url(`/p/${p.slug}`)}): from ${formatUsd(n(p.from_cents))}`);
  }
  const published = pages.filter((p) => p.published);
  if (published.length) {
    lines.push("", "## Policies", "");
    for (const p of published) lines.push(`- [${md(p.titleEn || p.titleAr)}](${url(`/legal/${p.slug}`)})`);
  }
  lines.push("", "## Optional", "", `- [Sitemap](${baseUrl}/sitemap.xml): every page, in both languages`, "");
  return lines.join("\n");
}

/** robots.txt: the private screens stay out of search results; with indexing off, everything does. */
export function robotsTxt(baseUrl: string, opts: { indexing?: boolean } = {}): string {
  if (opts.indexing === false) return ["User-agent: *", "Disallow: /", ""].join("\n");
  return [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /api/",
    "Disallow: /tg",
    "Disallow: /login",
    "Disallow: /wallet",
    "Disallow: /orders",
    "Disallow: /profile",
    "",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    "",
  ].join("\n");
}
