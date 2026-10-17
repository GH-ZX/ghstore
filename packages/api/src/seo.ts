/**
 * Search engines and link previews for a single-page app. The Worker answers the
 * public pages (/, /c/<slug>, /p/<slug>, /legal/<slug>) with the normal
 * index.html plus that page's title, description, picture, language versions
 * (?lang=en next to the default Arabic), structured data (JSON-LD), and the
 * page's content as plain HTML inside #root for crawlers (the app replaces it
 * when it starts; the splash covers it meanwhile). It also serves /sitemap.xml
 * and /robots.txt. The owner's settings are in Admin → SEO & pages.
 */
import { store } from "@store/config";
import { docPlainText, formatUsd, parseDoc, parseSpans } from "@store/core";
import type { Services } from "./context";
import { n, one, type Db } from "./db";
import { allPages, publishedPage } from "./pages";
import { channelUrl, readSettings } from "./settings";

type Locale = "ar" | "en";

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
  /** The owner's title and description for search results (Catalog → product → Search engines). */
  seoTitleAr?: string;
  seoTitleEn?: string;
  seoDescriptionAr?: string;
  seoDescriptionEn?: string;
  category?: { slug: string; nameAr: string; nameEn: string } | null;
  packages?: { nameAr: string; nameEn: string; priceCents: number }[];
}

export const PRODUCT_PATH = /^\/p\/([a-z0-9-]{1,80})\/?$/;
export const CATEGORY_PATH = /^\/c\/([a-z0-9-]{1,48})\/?$/;

/** A package on sale: active, not paused, and its supplier (if any) switched on. */
const ON_SALE = `o.active and o.paused_reason is null
  and (o.supplier_id is null or exists (select 1 from app.suppliers s where s.id = o.supplier_id and s.enabled))`;

// ─────────────────────────────────────────────────────────────── settings

export interface SeoSettings {
  titleAr: string | null;
  titleEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  /** The picture shown when the store's pages are shared (1200×630 is best). */
  imageUrl: string | null;
  /** Search Console and Bing Webmaster verification codes. */
  google: string | null;
  bing: string | null;
  /** false: ask search engines not to list the store (robots.txt and a noindex tag). */
  indexing: boolean;
}

export const SEO_KEYS = [
  "seo.title_ar", "seo.title_en", "seo.description_ar", "seo.description_en", "seo.image_url",
  "seo.google_verification", "seo.bing_verification", "seo.indexing",
] as const;

export async function seoSettings(db: Db): Promise<SeoSettings> {
  const s = await readSettings(db, [...SEO_KEYS]);
  const text = (k: string) => (typeof s[k] === "string" && (s[k] as string).trim() ? (s[k] as string).trim() : null);
  const image = text("seo.image_url");
  return {
    titleAr: text("seo.title_ar"),
    titleEn: text("seo.title_en"),
    descriptionAr: text("seo.description_ar"),
    descriptionEn: text("seo.description_en"),
    imageUrl: image && /^https:\/\/\S{4,}$/.test(image) ? image : null,
    google: text("seo.google_verification"),
    bing: text("seo.bing_verification"),
    indexing: s["seo.indexing"] !== false,
  };
}

// ─────────────────────────────────────────────────────────────── page head

export interface PageOpts {
  baseUrl: string;
  storeName: string;
  locale: Locale;
  /** The store's default language: its pages have no ?lang=. With it, the page lists its language versions. */
  defaultLocale?: Locale;
  seo?: SeoSettings | null;
  /** The store's own share picture, when the owner set none (client/public/promo/share.jpg). */
  shareImage?: string;
}

export interface PageHead {
  /** The page's path without ?lang= ("/", "/p/pubg"). */
  path: string;
  /** The browser tab's and the search result's title. */
  title: string;
  /** The title in link previews (defaults to `title`). */
  shareTitle?: string;
  description: string;
  image?: string | null;
  type?: "website" | "product" | "article";
  jsonLd?: unknown[];
  /** The page's content as HTML, for crawlers (already escaped). */
  body?: string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

function plain(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The address of a page in a language: the default language has no ?lang=. */
function localUrl(o: PageOpts, path: string, l: Locale, absolute = true): string {
  const own = l === (o.defaultLocale ?? o.locale);
  return `${absolute ? o.baseUrl : ""}${path}${own ? "" : `?lang=${l}`}`;
}

/** index.html with a page's head tags (and its content for crawlers). */
export function renderPage(indexHtml: string, head: PageHead, o: PageOpts): string {
  const l = o.locale;
  const url = localUrl(o, head.path, l);
  const ownImage = head.image ?? o.seo?.imageUrl ?? o.shareImage ?? null;
  const image = ownImage ?? `${o.baseUrl}/icon-512.png`;
  const versions = o.defaultLocale
    ? [
        ...(["ar", "en"] as const).map((x) => `<link rel="alternate" hreflang="${x}" href="${escapeHtml(localUrl(o, head.path, x))}">`),
        `<link rel="alternate" hreflang="x-default" href="${escapeHtml(localUrl(o, head.path, o.defaultLocale))}">`,
      ]
    : [];
  const tags = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    ...versions,
    `<meta property="og:type" content="${head.type ?? "website"}">`,
    `<meta property="og:site_name" content="${escapeHtml(o.storeName)}">`,
    `<meta property="og:title" content="${escapeHtml(head.shareTitle ?? head.title)}">`,
    `<meta property="og:description" content="${escapeHtml(head.description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="og:locale" content="${l === "ar" ? "ar_AR" : "en_US"}">`,
    `<meta name="twitter:card" content="${ownImage ? "summary_large_image" : "summary"}">`,
    ...(o.seo?.google ? [`<meta name="google-site-verification" content="${escapeHtml(o.seo.google)}">`] : []),
    ...(o.seo?.bing ? [`<meta name="msvalidate.01" content="${escapeHtml(o.seo.bing)}">`] : []),
    ...(o.seo?.indexing === false ? [`<meta name="robots" content="noindex">`] : []),
    // JSON inside <script> must not be able to close the tag.
    ...(head.jsonLd ?? []).map((ld) => `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`),
  ].join("\n");

  // Replacer functions, never replacement strings: "$&" or "$'" in a product's
  // text must stay text, not splice parts of the page back in.
  let html = indexHtml
    // The template's own site-wide preview tags make way for the page's.
    .replace(/<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>\n?/g, () => "")
    .replace(/<link rel="canonical"[^>]*>\n?/g, () => "")
    .replace(/<html[^>]*>/, () => `<html lang="${l}" dir="${l === "ar" ? "rtl" : "ltr"}">`)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(head.title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escapeHtml(head.description)}">`)
    .replace("</head>", () => `${tags}\n</head>`);
  if (head.body) html = html.replace(/<div id="root"><\/div>/, () => `<div id="root">${head.body}</div>`);
  return html;
}

// ─────────────────────────────────────────────────────────────── content for crawlers

const WORDS = {
  ar: { home: "الرئيسية", categories: "الأقسام", popular: "الأكثر طلباً", from: "من", packages: "الباقات", instant: "تسليم فوري", updated: "آخر تحديث" },
  en: { home: "Home", categories: "Categories", popular: "Popular", from: "from", packages: "Packages", instant: "Instant delivery", updated: "Last updated" },
};

/** Page text (parseDoc's marks) as HTML. */
export function docHtml(source: string): string {
  const spans = (text: string) =>
    parseSpans(text)
      .map((s) => (s.type === "bold" ? `<strong>${escapeHtml(s.text)}</strong>` : s.type === "link" ? `<a href="${escapeHtml(s.href)}">${escapeHtml(s.text)}</a>` : escapeHtml(s.text)))
      .join("");
  return parseDoc(source)
    .map((b) => (b.type === "ul" ? `<ul>${b.items.map((i) => `<li>${spans(i)}</li>`).join("")}</ul>` : `<${b.type}>${spans(b.text)}</${b.type}>`))
    .join("\n");
}

function crumbs(o: PageOpts, items: { name: string; path: string }[]): string {
  const all = [{ name: WORDS[o.locale].home, path: "/" }, ...items];
  return `<nav>${all.map((c) => `<a href="${escapeHtml(localUrl(o, c.path, o.locale, false))}">${escapeHtml(c.name)}</a>`).join(" › ")}</nav>`;
}

function breadcrumbLd(o: PageOpts, items: { name: string; path: string }[]) {
  const all = [{ name: WORDS[o.locale].home, path: "/" }, ...items];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: all.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: localUrl(o, c.path, o.locale) })),
  };
}

const pick = (l: Locale, ar: string, en: string) => ((l === "ar" ? ar || en : en || ar) ?? "").trim();

interface ProductCardRow { slug: string; name_ar: string; name_en: string; from_cents: string | number }

function productList(o: PageOpts, rows: ProductCardRow[]): string {
  const w = WORDS[o.locale];
  return `<ul>${rows
    .map((r) => `<li><a href="${escapeHtml(localUrl(o, `/p/${r.slug}`, o.locale, false))}">${escapeHtml(pick(o.locale, r.name_ar, r.name_en))}</a> — ${w.from} ${formatUsd(n(r.from_cents))}</li>`)
    .join("")}</ul>`;
}

async function productsOnSale(db: Db, category: string | null, limit: number): Promise<ProductCardRow[]> {
  return db.query<ProductCardRow>(
    `select p.slug, p.name_ar, p.name_en, min(o.price_cents) as from_cents
       from app.products p join app.categories c on c.id = p.category_id
       join app.offers o on o.product_id = p.id and ${ON_SALE}
      where p.active and c.active and ($1::text is null or c.slug = $1)
      group by p.id
      order by p.featured desc, p.sort, p.name_en
      limit $2`,
    [category, limit],
  );
}

// ─────────────────────────────────────────────────────────────── pages

/** The home page: the owner's title and description (Admin → SEO & pages), the store's categories and popular products. */
export async function homeHead(svc: Pick<Services, "db">, o: PageOpts): Promise<PageHead> {
  const l = o.locale;
  const w = WORDS[l];
  const tagline = store.tagline[l];
  const title = (l === "ar" ? o.seo?.titleAr : o.seo?.titleEn) ?? `${o.storeName} | ${tagline.replace(/[.。]$/, "")}`;
  const description = (l === "ar" ? o.seo?.descriptionAr : o.seo?.descriptionEn) ?? tagline;
  const [cats, products, channel] = await Promise.all([
    svc.db.query<{ slug: string; name_ar: string; name_en: string }>(
      `select c.slug, c.name_ar, c.name_en from app.categories c
        where c.active and exists (select 1 from app.products p join app.offers o on o.product_id = p.id and ${ON_SALE} where p.category_id = c.id and p.active)
        order by c.sort, c.slug`,
    ),
    productsOnSale(svc.db, null, 40),
    channelUrl(svc.db),
  ]);
  const body = [
    `<main>`,
    `<h1>${escapeHtml(o.storeName)}</h1>`,
    `<p>${escapeHtml(description)}</p>`,
    `<h2>${w.categories}</h2>`,
    `<ul>${cats.map((c) => `<li><a href="${escapeHtml(localUrl(o, `/c/${c.slug}`, l, false))}">${escapeHtml(pick(l, c.name_ar, c.name_en))}</a></li>`).join("")}</ul>`,
    `<h2>${w.popular}</h2>`,
    productList(o, products),
    `</main>`,
  ].join("\n");
  return {
    path: "/",
    title,
    shareTitle: (l === "ar" ? o.seo?.titleAr : o.seo?.titleEn) ?? o.storeName,
    description,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: o.storeName,
        url: `${o.baseUrl}/`,
        logo: `${o.baseUrl}/icon-512.png`,
        ...(channel ? { sameAs: [channel] } : {}),
      },
      { "@context": "https://schema.org", "@type": "WebSite", name: o.storeName, url: `${o.baseUrl}/`, inLanguage: l },
    ],
    body,
  };
}

/** A category's page, or null when it is not on show. */
export async function categoryHead(svc: Pick<Services, "db">, slug: string, o: PageOpts): Promise<PageHead | null> {
  const l = o.locale;
  const cat = await one<{ slug: string; name_ar: string; name_en: string }>(
    svc.db,
    `select slug, name_ar, name_en from app.categories where slug = $1 and active`,
    [slug],
  );
  if (!cat) return null;
  const products = await productsOnSale(svc.db, slug, 200);
  const name = pick(l, cat.name_ar, cat.name_en);
  const names = products.slice(0, 6).map((p) => pick(l, p.name_ar, p.name_en)).join(l === "ar" ? "، " : ", ");
  const description = plain(
    l === "ar"
      ? `${name} من ${o.storeName}${names ? `: ${names}` : ""}. أسعار بالدولار وتسليم فوري.`
      : `${name} at ${o.storeName}${names ? `: ${names}` : ""}. Prices in US dollars, instant delivery.`,
    200,
  );
  const path = `/c/${cat.slug}`;
  return {
    path,
    title: `${name} | ${o.storeName}`,
    shareTitle: name,
    description,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name,
        itemListElement: products.slice(0, 100).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: localUrl(o, `/p/${p.slug}`, l), name: pick(l, p.name_ar, p.name_en) })),
      },
      breadcrumbLd(o, [{ name, path }]),
    ],
    body: [`<main>`, crumbs(o, [{ name, path }]), `<h1>${escapeHtml(name)}</h1>`, `<p>${escapeHtml(description)}</p>`, productList(o, products), `</main>`].join("\n"),
  };
}

/** A page of the owner's (terms, privacy…), or null when it is not published. */
export async function legalHead(svc: Pick<Services, "db">, slug: string, o: PageOpts): Promise<PageHead | null> {
  const p = await publishedPage(svc.db, o.baseUrl, slug);
  if (!p) return null;
  const l = o.locale;
  const title = pick(l, p.titleAr, p.titleEn);
  const text = pick(l, p.bodyAr, p.bodyEn);
  const date = new Date(p.updatedAt).toISOString().slice(0, 10);
  return {
    path: `/legal/${p.slug}`,
    title: `${title} | ${o.storeName}`,
    shareTitle: title,
    description: plain(docPlainText(text), 160),
    type: "article",
    body: [`<main><article>`, crumbs(o, [{ name: title, path: `/legal/${p.slug}` }]), `<h1>${escapeHtml(title)}</h1>`, `<p>${WORDS[l].updated}: ${date}</p>`, docHtml(text), `</article></main>`].join("\n"),
  };
}

// ─────────────────────────────────────────────────────────────── products

/** A sellable product's public details, or null (unknown or not on sale). */
export async function productMeta(svc: Pick<Services, "db">, slug: string): Promise<ProductMeta | null> {
  const r = await one<{
    slug: string; name_ar: string; name_en: string; description_ar: string; description_en: string; image_url: string | null;
    min_cents: string | number | null; max_cents: string | number | null; offers: string | number;
    seo_title_ar: string; seo_title_en: string; seo_description_ar: string; seo_description_en: string;
    cat_slug: string | null; cat_ar: string | null; cat_en: string | null;
  }>(
    svc.db,
    `select p.slug, p.name_ar, p.name_en, p.description_ar, p.description_en, p.image_url,
            p.seo_title_ar, p.seo_title_en, p.seo_description_ar, p.seo_description_en,
            c.slug as cat_slug, c.name_ar as cat_ar, c.name_en as cat_en,
            min(o.price_cents) as min_cents, max(o.price_cents) as max_cents, count(o.id) as offers
       from app.products p
       left join app.categories c on c.id = p.category_id and c.active
       left join app.offers o on o.product_id = p.id and ${ON_SALE}
      where p.slug = $1 and p.active
      group by p.id, c.id`,
    [slug],
  );
  if (!r) return null;
  const packages = await svc.db.query<{ name_ar: string; name_en: string; price_cents: string | number }>(
    `select o.name_ar, o.name_en, o.price_cents from app.offers o join app.products p on p.id = o.product_id
      where p.slug = $1 and ${ON_SALE} order by o.sort, o.price_cents limit 40`,
    [slug],
  );
  return {
    slug: r.slug, nameAr: r.name_ar, nameEn: r.name_en, descriptionAr: r.description_ar, descriptionEn: r.description_en,
    imageUrl: r.image_url && /^https:\/\//.test(r.image_url) ? r.image_url : null,
    minCents: r.min_cents === null ? null : n(r.min_cents),
    maxCents: r.max_cents === null ? null : n(r.max_cents),
    offers: n(r.offers),
    seoTitleAr: r.seo_title_ar, seoTitleEn: r.seo_title_en, seoDescriptionAr: r.seo_description_ar, seoDescriptionEn: r.seo_description_en,
    category: r.cat_slug ? { slug: r.cat_slug, nameAr: r.cat_ar ?? "", nameEn: r.cat_en ?? "" } : null,
    packages: packages.map((p) => ({ nameAr: p.name_ar, nameEn: p.name_en, priceCents: n(p.price_cents) })),
  };
}

/** A product page's head: the owner's search title and description when set, else its name, price and description. */
export function productHead(meta: ProductMeta, o: PageOpts): PageHead {
  const l = o.locale;
  const ar = l === "ar";
  const name = pick(l, meta.nameAr, meta.nameEn);
  const other = (ar ? meta.nameEn : meta.nameAr).trim();
  const image = meta.imageUrl ?? null;
  const price = meta.minCents === null ? "" : ar ? `من ${formatUsd(meta.minCents)}` : `From ${formatUsd(meta.minCents)}`;
  const desc = plain(pick(l, meta.descriptionAr, meta.descriptionEn), 160);
  const ownDescription = (ar ? meta.seoDescriptionAr : meta.seoDescriptionEn)?.trim();
  const description = ownDescription
    ? plain(ownDescription, 320)
    : plain([price, WORDS[l].instant, other && other !== name ? other : "", desc].filter(Boolean).join(" · "), 200);
  const ownTitle = (ar ? meta.seoTitleAr : meta.seoTitleEn)?.trim();
  const path = `/p/${meta.slug}`;
  const trail = [...(meta.category ? [{ name: pick(l, meta.category.nameAr, meta.category.nameEn), path: `/c/${meta.category.slug}` }] : []), { name, path }];

  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    ...(other && other !== name ? { alternateName: other } : {}),
    image: image ?? `${o.baseUrl}/icon-512.png`,
    url: localUrl(o, path, l),
    ...(desc ? { description: desc } : {}),
    brand: { "@type": "Brand", name: o.storeName },
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
  const packages = meta.packages ?? [];
  const body = [
    `<main>`,
    crumbs(o, trail),
    `<h1>${escapeHtml(name)}</h1>`,
    desc ? `<p>${escapeHtml(desc)}</p>` : "",
    packages.length
      ? `<h2>${WORDS[l].packages}</h2><ul>${packages.map((p) => `<li>${escapeHtml(pick(l, p.nameAr, p.nameEn))} — ${formatUsd(p.priceCents)}</li>`).join("")}</ul>`
      : "",
    `</main>`,
  ].filter(Boolean).join("\n");
  return {
    path,
    title: ownTitle || `${name} | ${o.storeName}`,
    shareTitle: ownTitle || name,
    description,
    image,
    type: "product",
    jsonLd: [product, ...(o.defaultLocale ? [breadcrumbLd(o, trail)] : [])],
    body,
  };
}

/** index.html with the product's head tags (link previews, search engines). */
export function renderProductPage(indexHtml: string, meta: ProductMeta, opts: PageOpts): string {
  return renderPage(indexHtml, productHead(meta, opts), opts);
}

// ─────────────────────────────────────────────────────────────── sitemap, robots

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
