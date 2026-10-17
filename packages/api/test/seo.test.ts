/** Link previews (product pages), sitemap and robots. */
import { afterAll, describe, expect, it } from "vitest";
import { categoryHead, homeHead, legalHead, llmsTxt, productMeta, renderPage, renderProductPage, robotsTxt, sitemapXml } from "../src/index";
import { publishedPage } from "../src/pages";
import { docHtml, slidePreloads } from "../src/seo";
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

  it("preloads the showcase's first picture near the top of the head, sized like the slide", () => {
    const url = "https://abcd.supabase.co/storage/v1/object/public/store-images/banner.jpg";
    const html = renderPage(
      INDEX.replace("<head>\n", "<head>\n<!--preload-->\n"),
      { path: "/", title: "GH Store", description: "d", preload: slidePreloads(url) },
      { baseUrl: "https://gh-store.me", storeName: "GH Store", locale: "ar" },
    );
    const head = html.slice(0, html.indexOf("<title>"));
    expect(head).toContain('<link rel="preload" as="image" href="https://abcd.supabase.co/storage/v1/render/image/public/store-images/banner.jpg?width=720&amp;');
    expect(head).toContain('media="(max-width: 799px)" fetchpriority="high" referrerpolicy="no-referrer">');
    expect(head).toContain('media="(min-width: 800px)"');
    expect(html).not.toContain("<!--preload-->");
    // A picture hosted elsewhere is preloaded as it is
    expect(slidePreloads("https://cdn.example/hero.jpg")).toEqual([{ href: "https://cdn.example/hero.jpg", high: true }]);
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

describe("store pages and search engines", () => {
  const o = { baseUrl: "https://gh-store.me", storeName: "GH Store", locale: "en" as const, defaultLocale: "ar" as const, seo: null };

  it("shows the built-in legal pages with their placeholders filled in", async () => {
    await db.query(`delete from app.pages where slug in ('terms', 'privacy', 'refund')`);
    const p = await publishedPage(db, "https://gh-store.me", "refund");
    expect(p?.titleEn).toBe("Refund policy");
    expect(p?.bodyEn).toContain("GH Store wallet");
    expect(p?.bodyEn).not.toMatch(/\{(store|site|url|contact)\}/);
    const head = await legalHead({ db }, "terms", o);
    expect(head?.title).toBe("Terms of service | GH Store");
    expect(head?.body).toContain('<a href="https://gh-store.me/legal/refund">refund policy</a>');
    expect(await legalHead({ db }, `nope-${run}`, o)).toBeNull();
  });

  it("uses the owner's version of a page, and hides an unpublished one", async () => {
    await db.query(
      `insert into app.pages (slug, title_ar, title_en, body_ar, body_en, published) values ($1, 'من نحن', 'About', 'نص', $2, true)`,
      [`about-${run}`, "## Who\n- **{store}** $& <b>"],
    );
    const head = await legalHead({ db }, `about-${run}`, o);
    expect(head?.body).toContain("<h2>Who</h2>");
    expect(head?.body).toContain("<li><strong>GH Store</strong> $&amp; &lt;b&gt;</li>");
    await db.query(`update app.pages set published = false where slug = $1`, [`about-${run}`]);
    expect(await legalHead({ db }, `about-${run}`, o)).toBeNull();
  });

  it("keeps page text from becoming markup or odd links", () => {
    const html = docHtml(`[x](javascript:alert(1)) [y](https://a.example/"onmouseover=1) <script>`);
    // Only https: and mailto: become links; the rest stays text.
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("gives the home page and categories their own head, with both languages", async () => {
    const home = await homeHead({ db }, o);
    const html = renderPage(INDEX, home, o);
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('<link rel="canonical" href="https://gh-store.me/?lang=en">');
    expect(html).toContain('<link rel="alternate" hreflang="ar" href="https://gh-store.me/">');
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://gh-store.me/">');
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('<div id="root"><main>');
    const cat = await categoryHead({ db }, "games", { ...o, locale: "ar" });
    expect(cat?.title).toMatch(/ \| GH Store$/);
    expect(await categoryHead({ db }, `nope-${run}`, o)).toBeNull();
  });

  it("describes the store for AI assistants in llms.txt, with a link per category and product", async () => {
    const text = await llmsTxt({ db }, "https://gh-store.me", "ar");
    expect(text).not.toBeNull();
    expect(text!.startsWith("# GH Store\n")).toBe(true);
    expect(text).toMatch(/^> .+/m);
    expect(text).toContain("## Categories");
    expect(text).toMatch(/- \[[^\]]+\]\(https:\/\/gh-store\.me\/c\/[a-z0-9-]+\?lang=en\): \d+ products?/);
    expect(text).toMatch(/- \[[^\]]+\]\(https:\/\/gh-store\.me\/p\/[a-z0-9-]+\?lang=en\): from \$\d+\.\d\d/);
    expect(text).toContain("](https://gh-store.me/legal/terms?lang=en)");
    expect(text).toContain("[Sitemap](https://gh-store.me/sitemap.xml)");
  });

  it("lists categories, pages and the English versions in the sitemap; robots follows the switch", async () => {
    const xml = await sitemapXml({ db }, "https://gh-store.me", "ar");
    expect(xml).toContain("<loc>https://gh-store.me/legal/terms</loc>");
    expect(xml).toContain("<loc>https://gh-store.me/legal/terms?lang=en</loc>");
    expect(xml).toContain('hreflang="en" href="https://gh-store.me/?lang=en"');
    expect(xml).not.toContain(`about-${run}`);
    expect(robotsTxt("https://gh-store.me", { indexing: false })).toBe("User-agent: *\nDisallow: /\n");
    expect(robotsTxt("https://gh-store.me")).toContain("Disallow: /wallet");
  });
});
