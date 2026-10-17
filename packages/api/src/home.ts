/**
 * The home page (Admin → Home): the banners of the carousel at the top, and
 * the order, icon and visibility of the category sections below it.
 */
import { audit } from "./audit";
import type { Ctx } from "./context";
import type { Db } from "./db";
import { must, n, one } from "./db";
import { requireStaff } from "./guard";
import { ApiError, int, json, readJson, uuid } from "./http";

const LINK_TYPES = ["none", "product", "category", "url"] as const;
const STYLES = ["accent", "dark", "light"] as const;
const LOOKS = ["cinematic", "deal"] as const;
const PICTURES = ["auto", "wide", "square"] as const;
/** The icon names the web app draws (apps/web/client/src/ui/icons.tsx, CATEGORY_ICONS). */
export const CATEGORY_ICON_NAMES = [
  "game", "gift", "spark", "play", "palette", "briefcase", "shield", "phone", "bolt", "code",
  "music", "book", "card", "globe", "star", "cart", "chat", "cloud",
] as const;

interface BannerRow {
  id: string;
  title_ar: string;
  title_en: string;
  subtitle_ar: string;
  subtitle_en: string;
  cta_ar: string;
  cta_en: string;
  image_url: string | null;
  link_type: (typeof LINK_TYPES)[number];
  link_value: string | null;
  style: (typeof STYLES)[number];
  look: (typeof LOOKS)[number] | null;
  picture_mode: (typeof PICTURES)[number] | null;
  sort: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

const BANNER_COLS = `id, title_ar, title_en, subtitle_ar, subtitle_en, cta_ar, cta_en, image_url, link_type, link_value, style, look, picture_mode, sort, active, starts_at, ends_at`;

function publicBanner(b: BannerRow) {
  return {
    id: b.id,
    titleAr: b.title_ar,
    titleEn: b.title_en,
    subtitleAr: b.subtitle_ar,
    subtitleEn: b.subtitle_en,
    ctaAr: b.cta_ar,
    ctaEn: b.cta_en,
    imageUrl: b.image_url,
    link: b.link_type === "none" || !b.link_value ? null : { type: b.link_type, value: b.link_value },
    style: b.style,
    /** null: the store's default look. */
    look: b.look,
    /** Which of the product's pictures: wide cover, square icon or auto; null: the store's setting. */
    pictureMode: b.picture_mode,
  };
}

/**
 * Banners on show now, for the store. A banner that opens a product or a
 * category that is not on sale any more is left out rather than lead nowhere.
 */
export async function liveBanners(db: Db) {
  const rows = await db.query<BannerRow>(
    `select ${BANNER_COLS.split(", ").map((c) => `b.${c}`).join(", ")}
       from app.banners b
      where b.active
        and (b.starts_at is null or b.starts_at <= now())
        and (b.ends_at is null or b.ends_at > now())
        and (b.link_type <> 'product' or exists (select 1 from app.products p where p.slug = b.link_value and p.active))
        and (b.link_type <> 'category' or exists (select 1 from app.categories c where c.slug = b.link_value and c.active))
      order by b.sort, b.created_at
      limit 12`,
  );
  return rows.map(publicBanner);
}

// ─────────────────────────────────────────────────────────────── admin

function text(body: Record<string, unknown>, key: string, max: number, required: boolean): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ApiError("invalid_input", key);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > max || (required && s.length === 0)) throw new ApiError("invalid_input", key);
  return s;
}

function when(body: Record<string, unknown>, key: string): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new ApiError("invalid_input", key);
  return new Date(v).toISOString();
}

/** Checks the link points somewhere real: a product or category slug, a https link or a path in the store. */
async function checkLink(db: Db, type: string, value: string | null): Promise<void> {
  if (type === "none") return;
  if (!value) throw new ApiError("invalid_input", "linkValue");
  if (type === "product" && !(await one(db, `select 1 from app.products where slug = $1`, [value]))) throw new ApiError("invalid_input", "linkValue");
  if (type === "category" && !(await one(db, `select 1 from app.categories where slug = $1`, [value]))) throw new ApiError("invalid_input", "linkValue");
  if (type === "url" && !/^(https:\/\/[^\s"<>]{4,290}|\/[A-Za-z0-9/_?=&.-]{0,200})$/.test(value)) throw new ApiError("invalid_input", "linkValue");
}

function bannerChanges(body: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const set = (col: string, v: unknown) => {
    if (v !== undefined) c[col] = v;
  };
  set("title_ar", text(body, "titleAr", 80, true));
  set("title_en", text(body, "titleEn", 80, true));
  set("subtitle_ar", text(body, "subtitleAr", 160, false));
  set("subtitle_en", text(body, "subtitleEn", 160, false));
  set("cta_ar", text(body, "ctaAr", 24, false));
  set("cta_en", text(body, "ctaEn", 24, false));
  if (body.imageUrl !== undefined) {
    const url = body.imageUrl === null || body.imageUrl === "" ? null : text(body, "imageUrl", 500, true);
    if (url && !/^https:\/\/[^\s"<>]{4,500}$/.test(url)) throw new ApiError("invalid_input", "imageUrl");
    c.image_url = url ?? null;
  }
  if (body.linkType !== undefined) {
    if (!LINK_TYPES.includes(body.linkType as never)) throw new ApiError("invalid_input", "linkType");
    c.link_type = body.linkType;
    c.link_value = body.linkType === "none" ? null : text(body, "linkValue", 300, true) ?? null;
  }
  if (body.style !== undefined) {
    if (!STYLES.includes(body.style as never)) throw new ApiError("invalid_input", "style");
    c.style = body.style;
  }
  if (body.pictureMode !== undefined) {
    if (body.pictureMode !== null && !PICTURES.includes(body.pictureMode as never)) throw new ApiError("invalid_input", "pictureMode");
    c.picture_mode = body.pictureMode;
  }
  if (body.look !== undefined) {
    if (body.look !== null && !LOOKS.includes(body.look as never)) throw new ApiError("invalid_input", "look");
    c.look = body.look;
  }
  if (body.sort !== undefined) c.sort = int(body, "sort", -10_000, 10_000);
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new ApiError("invalid_input", "active");
    c.active = body.active;
  }
  set("starts_at", when(body, "startsAt"));
  set("ends_at", when(body, "endsAt"));
  if (creating) for (const k of ["title_ar", "title_en"]) if (c[k] === undefined) throw new ApiError("invalid_input", k);
  return c;
}

function adminBanner(b: BannerRow) {
  return { ...publicBanner(b), linkType: b.link_type, linkValue: b.link_value, sort: b.sort, active: b.active, startsAt: b.starts_at, endsAt: b.ends_at };
}

export async function listBanners(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const rows = await ctx.svc.db.query<BannerRow>(`select ${BANNER_COLS} from app.banners order by sort, created_at`);
  const categories = await ctx.svc.db.query<{ id: string; slug: string; name_ar: string; name_en: string; icon: string | null; sort: number; active: boolean; products: string | number }>(
    `select c.id, c.slug, c.name_ar, c.name_en, c.icon, c.sort, c.active,
            (select count(*) from app.products p where p.category_id = c.id and p.active) as products
       from app.categories c order by c.sort, c.slug`,
  );
  return json({
    banners: rows.map(adminBanner),
    categories: categories.map((c) => ({ id: c.id, slug: c.slug, nameAr: c.name_ar, nameEn: c.name_en, icon: c.icon, sort: c.sort, active: c.active, products: n(c.products) })),
    icons: CATEGORY_ICON_NAMES,
  });
}

export async function createBanner(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req);
  const c = bannerChanges(body, true);
  await checkLink(ctx.svc.db, String(c.link_type ?? "none"), (c.link_value as string | null) ?? null);
  if (c.sort === undefined) {
    const last = await one<{ s: number | null }>(ctx.svc.db, `select max(sort) as s from app.banners`);
    c.sort = (last?.s ?? 0) + 10;
  }
  const cols = Object.keys(c);
  const row = await must<BannerRow>(
    ctx.svc.db,
    `insert into app.banners (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning ${BANNER_COLS}`,
    cols.map((k) => c[k]),
  );
  await audit(ctx.svc.db, { actor: staff.id, action: "banner.create", targetType: "banner", targetId: row.id, data: { title: row.title_en } });
  return json({ banner: adminBanner(row) }, { status: 201 });
}

export async function updateBanner(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const c = bannerChanges(body, false);
  const cols = Object.keys(c);
  if (!cols.length) throw new ApiError("bad_request");
  const cur = await must<BannerRow>(ctx.svc.db, `select ${BANNER_COLS} from app.banners where id = $1`, [id]);
  await checkLink(ctx.svc.db, String(c.link_type ?? cur.link_type), (c.link_type !== undefined ? c.link_value : cur.link_value) as string | null);
  const row = await must<BannerRow>(
    ctx.svc.db,
    `update app.banners set ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1 returning ${BANNER_COLS}`,
    [id, ...cols.map((k) => c[k])],
  );
  await audit(ctx.svc.db, { actor: staff.id, action: "banner.update", targetType: "banner", targetId: id, data: { fields: cols } });
  return json({ banner: adminBanner(row) });
}

export async function deleteBanner(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const gone = await ctx.svc.db.query(`delete from app.banners where id = $1 returning id`, [id]);
  if (!gone.length) throw new ApiError("not_found");
  await audit(ctx.svc.db, { actor: staff.id, action: "banner.delete", targetType: "banner", targetId: id });
  return json({ ok: true });
}

/** A category's icon, order, names or visibility on the home page. */
export async function updateCategory(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const c: Record<string, unknown> = {};
  if (body.icon !== undefined) {
    if (body.icon !== null && !CATEGORY_ICON_NAMES.includes(body.icon as never)) throw new ApiError("invalid_input", "icon");
    c.icon = body.icon;
  }
  if (body.sort !== undefined) c.sort = int(body, "sort", -10_000, 10_000);
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new ApiError("invalid_input", "active");
    c.active = body.active;
  }
  const ar = text(body, "nameAr", 40, true);
  if (ar !== undefined) c.name_ar = ar;
  const en = text(body, "nameEn", 40, true);
  if (en !== undefined) c.name_en = en;
  const cols = Object.keys(c);
  if (!cols.length) throw new ApiError("bad_request");
  const rows = await ctx.svc.db.query(`update app.categories set ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1 returning id`, [
    id,
    ...cols.map((k) => c[k]),
  ]);
  if (!rows.length) throw new ApiError("not_found");
  await audit(ctx.svc.db, { actor: staff.id, action: "category.update", targetType: "category", targetId: id, data: c });
  return json({ ok: true });
}
