/** Admin → Home: carousel banners and category sections, and what the store shows. */
import { afterAll, describe, expect, it } from "vitest";
import { connectTestDb, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);

afterAll(async () => {
  await db.query(`delete from app.banners where title_en like $1`, [`%${run}%`]);
  await conn.close();
});

async function product(active: boolean): Promise<string> {
  const slug = `home-${active ? "on" : "off"}-${run}`;
  await db.query(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active)
     values ($1, (select id from app.categories order by sort limit 1), 'منتج', 'Product', 'code', $2)`,
    [slug, active],
  );
  return slug;
}

describe("home page", () => {
  it("lets only the owner manage banners, and checks what they link to", async () => {
    const customer = await h.login(810_000_000 + (Date.now() % 1_000_000));
    expect((await h.call("GET", "/api/admin/home", { token: customer })).status).toBe(403);
    const owner = await h.login(900001, "Owner");
    const base = { titleAr: `عرض ${run}`, titleEn: `Offer ${run}` };
    expect((await h.call("POST", "/api/admin/banners", { token: owner, body: { titleAr: "x" } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/banners", { token: owner, body: { ...base, imageUrl: "http://plain.example/x.png" } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/banners", { token: owner, body: { ...base, linkType: "product", linkValue: "no-such-product" } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/banners", { token: owner, body: { ...base, linkType: "url", linkValue: "javascript:alert(1)" } })).status).toBe(400);
    expect((await h.call("POST", "/api/admin/banners", { token: owner, body: { ...base, style: "neon" } })).status).toBe(400);

    const ok = await h.call("POST", "/api/admin/banners", {
      token: owner,
      body: { ...base, subtitleEn: "Two lines\\nbecome one", ctaEn: "Shop", linkType: "category", linkValue: "games", imageUrl: "https://cdn.example/banner.png", style: "dark" },
    });
    expect(ok.status).toBe(201);
    expect(ok.data.banner).toMatchObject({ titleEn: `Offer ${run}`, link: { type: "category", value: "games" }, style: "dark", active: true });

    const id = ok.data.banner.id as string;
    const off = await h.call("PATCH", `/api/admin/banners/${id}`, { token: owner, body: { active: false } });
    expect(off.data.banner.active).toBe(false);
    const list = await h.call("GET", "/api/admin/home", { token: owner });
    expect(list.data.banners.some((b: { id: string }) => b.id === id)).toBe(true);
    expect(list.data.categories.find((c: { slug: string }) => c.slug === "games")).toMatchObject({ icon: "game" });
    expect(list.data.icons).toContain("spark");
    expect((await h.call("DELETE", `/api/admin/banners/${id}`, { token: owner })).status).toBe(200);
    expect((await h.call("DELETE", `/api/admin/banners/${id}`, { token: owner })).status).toBe(404);
  });

  it("shows only banners that are on, in their dates, and lead somewhere on sale", async () => {
    const owner = await h.login(900001, "Owner");
    const onSale = await product(true);
    const hidden = await product(false);
    const mk = (title: string, body: Record<string, unknown>) =>
      h.call("POST", "/api/admin/banners", { token: owner, body: { titleAr: title, titleEn: `${title} ${run}`, ...body } });
    await mk("live", { linkType: "product", linkValue: onSale, sort: 1 });
    await mk("later", { startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    await mk("over", { endsAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() - 86_400_000).toISOString() });
    await mk("product off", { linkType: "product", linkValue: hidden });
    await mk("off", { active: false });
    await mk("plain", { sort: 2 });

    const cat = await h.call("GET", "/api/catalog");
    const mine = cat.data.banners.filter((b: { titleEn: string }) => b.titleEn.endsWith(run)).map((b: { titleEn: string }) => b.titleEn);
    expect(mine).toEqual([`live ${run}`, `plain ${run}`]);
    expect(cat.data.categories.find((c: { slug: string }) => c.slug === "games").icon).toBe("game");
    // Searching or filtering shows products only.
    expect((await h.call("GET", "/api/catalog?q=pubg")).data.banners).toEqual([]);
  });

  it("orders, hides and draws categories from the admin", async () => {
    const owner = await h.login(900001, "Owner");
    const list = await h.call("GET", "/api/admin/home", { token: owner });
    const vouchers = list.data.categories.find((c: { slug: string }) => c.slug === "vouchers");
    expect((await h.call("PATCH", `/api/admin/categories/${vouchers.id}`, { token: owner, body: { icon: "skull" } })).status).toBe(400);
    expect((await h.call("PATCH", `/api/admin/categories/${vouchers.id}`, { token: owner, body: { icon: "card", sort: 5, active: false } })).status).toBe(200);
    const cat = await h.call("GET", "/api/catalog");
    expect(cat.data.categories.some((c: { slug: string }) => c.slug === "vouchers")).toBe(false);
    await h.call("PATCH", `/api/admin/categories/${vouchers.id}`, { token: owner, body: { icon: "gift", sort: vouchers.sort, active: true } });
    expect((await h.call("GET", "/api/catalog")).data.categories.find((c: { slug: string }) => c.slug === "vouchers").icon).toBe("gift");
  });
});
