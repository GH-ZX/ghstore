/** Link previews (product pages), sitemap and robots. */
import { afterAll, describe, expect, it } from "vitest";
import { productMeta, renderProductPage, robotsTxt, sitemapXml } from "../src/index";
import { connectTestDb } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const run = Date.now().toString(36);

afterAll(async () => {
  await conn.close();
});

const INDEX = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<title>GH Store</title>
<meta name="description" content="Site wide">
<link rel="canonical" href="https://gh-store.me/">
<meta property="og:type" content="website">
<meta property="og:title" content="GH Store">
<meta property="og:image" content="https://gh-store.me/icon-512.png">
<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="/assets/app.css">
</head>
<body><div id="root"></div></body>
</html>`;

describe("product link previews", () => {
  it("puts the product's name, price, picture and structured data in the page head", () => {
    const html = renderProductPage(
      INDEX,
      {
        slug: "pubg-uc", nameAr: "شدات ببجي", nameEn: "PUBG Mobile UC", descriptionAr: "شحن مباشر <فوري> إلى حسابك", descriptionEn: "",
        imageUrl: "https://img.example/pubg.png", minCents: 123, maxCents: 2500, offers: 4,
      },
      { baseUrl: "https://gh-store.me", storeName: "GH Store", locale: "ar" },
    );
    expect(html).toContain("<title>شدات ببجي | GH Store</title>");
    expect(html).toContain('<meta property="og:title" content="شدات ببجي">');
    expect(html).toContain('<meta property="og:image" content="https://img.example/pubg.png">');
    expect(html).toContain('<link rel="canonical" href="https://gh-store.me/p/pubg-uc">');
    expect(html).toContain("من $1.23 · تسليم فوري · PUBG Mobile UC · شحن مباشر &lt;فوري&gt; إلى حسابك");
    // the site-wide preview tags are replaced, not duplicated
    expect(html.match(/og:title/g)).toHaveLength(1);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).not.toContain('content="Site wide"');
    expect(html).toContain('<link rel="stylesheet" href="/assets/app.css">');
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*)<\/script>/.exec(html)![1]!);
    expect(ld.offers).toMatchObject({ "@type": "AggregateOffer", lowPrice: "1.23", highPrice: "25.00", priceCurrency: "USD", offerCount: 4 });
  });

  it("keeps $ signs in product text literal", () => {
    const html = renderProductPage(
      INDEX,
      { slug: "x", nameAr: "", nameEn: "Steam $& $' $` $$", descriptionAr: "", descriptionEn: 'Top up "10$" now', imageUrl: null, minCents: 100, maxCents: 100, offers: 1 },
      { baseUrl: "https://gh-store.me", storeName: "GH Store", locale: "en" },
    );
    expect(html).toContain("<title>Steam $&amp; $&#39; $` $$ | GH Store</title>");
    expect(html).toContain("Top up &quot;10$&quot; now");
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
    expect(html.match(/<\/head>/g)).toHaveLength(1);
  });

  it("cannot be used to inject markup", () => {
    const html = renderProductPage(
      INDEX,
      { slug: "x", nameAr: "", nameEn: `Evil "><script>alert(1)</script>`, descriptionAr: "", descriptionEn: "</script><script>alert(2)</script>", imageUrl: null, minCents: null, maxCents: null, offers: 0 },
      { baseUrl: "https://gh-store.me", storeName: "GH Store", locale: "en" },
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('<meta property="og:image" content="https://gh-store.me/icon-512.png">');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("reads only products on sale, and lists them in the sitemap", async () => {
    const cat = await db.query<{ id: string }>(`select id from app.categories where slug = 'games'`);
    const mk = async (slug: string, active: boolean, offerActive: boolean) => {
      const p = await db.query<{ id: string }>(
        `insert into app.products (slug, category_id, name_ar, name_en, kind, active, image_url) values ($1, $2, 'منتج', 'Product', 'code', $3, 'http://not-https.example/x.png') returning id`,
        [slug, cat[0]!.id, active],
      );
      await db.query(`insert into app.offers (product_id, name_ar, name_en, price_cents, active) values ($1, 'أ', 'A', 500, $2), ($1, 'ب', 'B', 300, true)`, [p[0]!.id, offerActive]);
    };
    await mk(`seo-on-${run}`, true, true);
    await mk(`seo-off-${run}`, false, true);
    const meta = await productMeta({ db }, `seo-on-${run}`);
    expect(meta).toMatchObject({ minCents: 300, maxCents: 500, offers: 2, imageUrl: null });
    expect(await productMeta({ db }, `seo-off-${run}`)).toBeNull();
    expect(await productMeta({ db }, `nope-${run}`)).toBeNull();
    const xml = await sitemapXml({ db }, "https://gh-store.me");
    expect(xml).toContain(`<loc>https://gh-store.me/p/seo-on-${run}</loc>`);
    expect(xml).not.toContain(`seo-off-${run}`);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(robotsTxt("https://gh-store.me")).toContain("Sitemap: https://gh-store.me/sitemap.xml");
  });
});
