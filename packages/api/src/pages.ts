/**
 * The store's own pages, shown at /legal/<slug> (Admin → SEO & pages): the
 * terms, privacy and refund policies built into the app (legal-defaults.ts) or
 * the owner's edited version of them, and pages the owner adds. {store}, {site},
 * {url} and {contact} in a page's text are filled in when it is shown.
 */
import { store } from "@store/config";
import { audit } from "./audit";
import type { Ctx } from "./context";
import type { Db } from "./db";
import { requireStaff } from "./guard";
import { ApiError, json, readJson, str } from "./http";
import { DEFAULT_PAGES, DEFAULTS_UPDATED } from "./legal-defaults";
import { supportContacts } from "./settings";

export const PAGE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const LEGAL_PATH = /^\/legal\/([a-z0-9-]{1,60})\/?$/;

export interface StorePage {
  slug: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  published: boolean;
  inFooter: boolean;
  sort: number;
  /** One of the pages built into the app (its text can go back to the built-in one). */
  builtIn: boolean;
  /** The owner changed it (a built-in page with the owner's text, or an added page). */
  edited: boolean;
  updatedAt: string;
}

interface PageRow {
  slug: string; title_ar: string; title_en: string; body_ar: string; body_en: string;
  published: boolean; in_footer: boolean; sort: number; updated_at: string | Date;
}

/** Every page: the built-in ones (or their edited version) and the owner's own, in their order. */
export async function allPages(db: Db): Promise<StorePage[]> {
  const rows = await db.query<PageRow>(`select slug, title_ar, title_en, body_ar, body_en, published, in_footer, sort, updated_at from app.pages`);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const fromRow = (r: PageRow, builtIn: boolean): StorePage => ({
    slug: r.slug, titleAr: r.title_ar, titleEn: r.title_en, bodyAr: r.body_ar, bodyEn: r.body_en,
    published: r.published, inFooter: r.in_footer, sort: r.sort, builtIn, edited: true, updatedAt: new Date(r.updated_at).toISOString(),
  });
  const pages = DEFAULT_PAGES.map((d) => {
    const r = bySlug.get(d.slug);
    return r
      ? fromRow(r, true)
      : { ...d, published: true, inFooter: true, builtIn: true, edited: false, updatedAt: DEFAULTS_UPDATED };
  });
  for (const r of rows) if (!DEFAULT_PAGES.some((d) => d.slug === r.slug)) pages.push(fromRow(r, false));
  return pages.sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug));
}

/** The support channels as list lines, for {contact}. */
async function contactText(db: Db, lang: "ar" | "en"): Promise<string> {
  const s = await supportContacts(db);
  const ar = lang === "ar";
  const lines = [
    s.telegram ? `- ${ar ? "تيليجرام" : "Telegram"}: [@${s.telegram}](https://t.me/${s.telegram})` : "",
    s.whatsapp ? `- ${ar ? "واتساب" : "WhatsApp"}: [+${s.whatsapp}](https://wa.me/${s.whatsapp})` : "",
    s.email ? `- ${ar ? "البريد" : "Email"}: [${s.email}](mailto:${s.email})` : "",
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : ar ? "من داخل المتجر: حسابي ← المساعدة والدعم." : "Inside the store: Profile → Help and support.";
}

/** A page's text with its placeholders filled in. */
export async function fillPage(db: Db, baseUrl: string, p: StorePage): Promise<StorePage> {
  const [ar, en] = await Promise.all([contactText(db, "ar"), contactText(db, "en")]);
  const site = baseUrl.replace(/^https?:\/\//, "");
  // Replacer functions: "$" in the owner's text stays text.
  const fill = (s: string, contact: string) =>
    s.replace(/\{(store|site|url|contact)\}/g, (_, k: string) => (k === "store" ? store.name : k === "site" ? site : k === "url" ? baseUrl : contact));
  return { ...p, bodyAr: fill(p.bodyAr, ar), bodyEn: fill(p.bodyEn, en), titleAr: fill(p.titleAr, ar), titleEn: fill(p.titleEn, en) };
}

/** A published page, ready to show, or null. */
export async function publishedPage(db: Db, baseUrl: string, slug: string): Promise<StorePage | null> {
  if (!PAGE_SLUG.test(slug)) return null;
  const p = (await allPages(db)).find((x) => x.slug === slug && x.published);
  return p ? fillPage(db, baseUrl, p) : null;
}

/** The pages linked at the bottom of the store (published, "in the footer"). */
export async function footerPages(db: Db): Promise<{ slug: string; titleAr: string; titleEn: string }[]> {
  return (await allPages(db)).filter((p) => p.published && p.inFooter).map((p) => ({ slug: p.slug, titleAr: p.titleAr, titleEn: p.titleEn }));
}

// ─────────────────────────────────────────────────────────────── API

/** GET /api/pages/:slug — a published page for the web app. */
export async function getPage(ctx: Ctx): Promise<Response> {
  const p = await publishedPage(ctx.svc.db, ctx.env.PUBLIC_BASE_URL, ctx.params.slug ?? "");
  if (!p) throw new ApiError("not_found");
  return json(
    { slug: p.slug, titleAr: p.titleAr, titleEn: p.titleEn, bodyAr: p.bodyAr, bodyEn: p.bodyEn, updatedAt: p.updatedAt },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}

/** GET /api/admin/pages — every page with its raw text (placeholders kept). */
export async function adminPages(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  return json({ pages: await allPages(ctx.svc.db) });
}

/** PUT /api/admin/pages/:slug — save a page (a built-in one's new text, or a page of the owner's). */
export async function savePage(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const slug = ctx.params.slug ?? "";
  if (!PAGE_SLUG.test(slug) || slug.length > 60) throw new ApiError("invalid_input", "slug");
  const body = await readJson(ctx.req, 262_144);
  const text = (key: string, max: number) => {
    const v = body[key];
    if (typeof v !== "string" || v.length > max) throw new ApiError("invalid_input", key);
    return v.replace(/\r\n?/g, "\n").trim();
  };
  const titleAr = str(body, "titleAr", { max: 120 });
  const titleEn = str(body, "titleEn", { max: 120 });
  const bodyAr = text("bodyAr", 60_000);
  const bodyEn = text("bodyEn", 60_000);
  const flag = (key: string, fallback: boolean) => (typeof body[key] === "boolean" ? (body[key] as boolean) : fallback);
  const sort = typeof body.sort === "number" && Number.isInteger(body.sort) && Math.abs(body.sort) <= 10_000 ? body.sort : DEFAULT_PAGES.find((d) => d.slug === slug)?.sort ?? 100;
  await ctx.svc.db.query(
    `insert into app.pages (slug, title_ar, title_en, body_ar, body_en, published, in_footer, sort) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (slug) do update set title_ar = excluded.title_ar, title_en = excluded.title_en, body_ar = excluded.body_ar, body_en = excluded.body_en,
       published = excluded.published, in_footer = excluded.in_footer, sort = excluded.sort`,
    [slug, titleAr, titleEn, bodyAr, bodyEn, flag("published", true), flag("inFooter", true), sort],
  );
  await audit(ctx.svc.db, { actor: staff.id, action: "page.save", targetType: "page", targetId: slug });
  return json({ pages: await allPages(ctx.svc.db) });
}

/** DELETE /api/admin/pages/:slug — a built-in page goes back to its built-in text; the owner's own page is removed. */
export async function deletePage(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const slug = ctx.params.slug ?? "";
  if (!PAGE_SLUG.test(slug)) throw new ApiError("invalid_input", "slug");
  await ctx.svc.db.query(`delete from app.pages where slug = $1`, [slug]);
  await audit(ctx.svc.db, { actor: staff.id, action: "page.delete", targetType: "page", targetId: slug });
  return json({ pages: await allPages(ctx.svc.db) });
}
