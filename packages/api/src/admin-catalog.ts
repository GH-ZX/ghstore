/**
 * Admin catalogue: categories, products, offers (packages) and manual stock.
 * Owner only. Every change is written to app.audit_log. The suppliers' own
 * settings and the Suppliers page are admin-suppliers.ts.
 *
 * What to sell from a supplier is chosen in Admin → Suppliers → Choose packages
 * (supplier-catalogue.ts, selection.ts). The sync keeps cost and price in line.
 */
import { encryptText, minimumPrice, parseAfterFields, priceFromCost, withUnit, type InputField, type MarkupMode } from "@store/core";
import { bool, optInt, optNum, updateRow } from "./admin-input";
import { audit } from "./audit";
import type { Ctx } from "./context";
import { call, must, n, one } from "./db";
import { requireStaff } from "./guard";
import { ApiError, int, json, optStr, readJson, str, SUPPLIER_ID, uuid } from "./http";
import { notifyBackInStock } from "./favorites";

const SLUG = /^[a-z0-9-]{1,80}$/;
const KINDS = ["id", "code", "account", "link", "sms"] as const;
const MODES: MarkupMode[] = ["percent", "fixed", "manual"];
/** The badges a product's card can carry (none by default). */
const BADGES = ["none", "instant", "new", "hot", "best", "sale"] as const;
/** auto: the supplier or the stock delivers; manual: a person does; review: the supplier does, a person releases it. */
const DELIVERY = ["auto", "manual", "review"] as const;

function httpsUrl(body: Record<string, unknown>, key: string): string | null | undefined {
  if (body[key] === null || body[key] === "") return null;
  const v = optStr(body, key, { max: 500 });
  if (v === undefined) return undefined;
  try {
    if (new URL(v).protocol === "https:") return v;
  } catch {
    /* fall through */
  }
  throw new ApiError("invalid_input", key);
}

/** Customer input fields for an offer (player id, server, email...). */
/** Letters (any script, with their marks), digits and a few separators suppliers use. */
export const FIELD_KEY = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_ .()/:-]{0,47}$/u;
/** Names that would clash with JavaScript object internals. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseInputFields(value: unknown): InputField[] {
  if (!Array.isArray(value) || value.length > 6) throw new ApiError("invalid_input", "inputFields");
  const seen = new Set<string>();
  return value.map((f) => {
    if (!f || typeof f !== "object") throw new ApiError("invalid_input", "inputFields");
    const o = f as Record<string, unknown>;
    // Supplier field names are kept exactly ("Player_ID", "معرّف اللاعب"): suppliers read them back.
    const key = str(o, "key", { max: 48, pattern: FIELD_KEY });
    if (RESERVED_KEYS.has(key)) throw new ApiError("invalid_input", "inputFields");
    if (seen.has(key)) throw new ApiError("invalid_input", "inputFields");
    seen.add(key);
    const field: InputField = { key, labelEn: str(o, "labelEn", { max: 60 }), required: o.required !== false };
    const labelAr = optStr(o, "labelAr", { max: 60 });
    if (labelAr) field.labelAr = labelAr;
    const pattern = optStr(o, "pattern", { max: 200 });
    if (pattern) {
      try {
        new RegExp(pattern);
      } catch {
        throw new ApiError("invalid_input", "inputFields");
      }
      field.pattern = pattern;
    }
    if (o.options !== undefined && o.options !== null) {
      if (!Array.isArray(o.options) || o.options.length > 50) throw new ApiError("invalid_input", "inputFields");
      const values = new Set<string>();
      const options = o.options.map((c) => {
        if (!c || typeof c !== "object") throw new ApiError("invalid_input", "inputFields");
        const co = c as Record<string, unknown>;
        const value = str(co, "value", { max: 80 });
        if (values.has(value)) throw new ApiError("invalid_input", "inputFields");
        values.add(value);
        const opt: { value: string; labelEn?: string; labelAr?: string } = { value };
        const en = optStr(co, "labelEn", { max: 60 });
        const ar = optStr(co, "labelAr", { max: 60 });
        if (en) opt.labelEn = en;
        if (ar) opt.labelAr = ar;
        return opt;
      });
      if (options.length) field.options = options;
    }
    return field;
  });
}

/** Text fields shared by create and update, mapped to their columns. */
const PRODUCT_TEXT: Array<[string, string, number]> = [
  ["nameAr", "name_ar", 120], ["nameEn", "name_en", 120],
  ["descriptionAr", "description_ar", 4000], ["descriptionEn", "description_en", 4000],
  ["instructionsAr", "instructions_ar", 2000], ["instructionsEn", "instructions_en", 2000],
  ["warrantyAr", "warranty_ar", 1000], ["warrantyEn", "warranty_en", 1000],
  ["searchTerms", "search_terms", 500],
  ["seoTitleAr", "seo_title_ar", 70], ["seoTitleEn", "seo_title_en", 70],
  ["seoDescriptionAr", "seo_description_ar", 320], ["seoDescriptionEn", "seo_description_en", 320],
];

function productChanges(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, col, max] of PRODUCT_TEXT) {
    const v = body[key];
    if (v === undefined) continue;
    if (col.startsWith("name_")) {
      out[col] = str(body, key, { max });
    } else {
      if (typeof v !== "string" || v.length > max) throw new ApiError("invalid_input", key);
      out[col] = v.trim();
    }
  }
  if (body.slug !== undefined) out.slug = str(body, "slug", { max: 80, pattern: SLUG });
  if (body.categoryId !== undefined) out.category_id = uuid(body.categoryId as string, "categoryId");
  if (body.kind !== undefined) {
    const kind = str(body, "kind", { max: 10 });
    if (!(KINDS as readonly string[]).includes(kind)) throw new ApiError("invalid_input", "kind");
    out.kind = kind;
  }
  const image = httpsUrl(body, "imageUrl");
  if (image !== undefined) out.image_url = image;
  // A wide picture for the home showcase, next to the square image.
  const cover = httpsUrl(body, "coverUrl");
  if (cover !== undefined) out.cover_url = cover;
  // The unit of packages named by their amount ("60" → "60 UC").
  for (const [key, col] of [["unitAr", "unit_ar"], ["unitEn", "unit_en"]] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim().length > 24) throw new ApiError("invalid_input", key);
    out[col] = v.replace(/\s+/g, " ").trim();
  }
  for (const [key, col] of [["active", "active"], ["featured", "featured"]] as const) {
    const v = bool(body, key);
    if (v !== undefined) out[col] = v;
  }
  const sort = optInt(body, "sort", -10_000, 10_000);
  if (sort !== undefined) out.sort = sort;
  if (body.badge !== undefined) {
    if (body.badge !== null && !(BADGES as readonly unknown[]).includes(body.badge)) throw new ApiError("invalid_input", "badge");
    out.badge = body.badge;
  }
  if (body.delivery !== undefined) {
    const d = str(body, "delivery", { max: 10 });
    if (!(DELIVERY as readonly string[]).includes(d)) throw new ApiError("invalid_input", "delivery");
    out.delivery = d;
  }
  // What the customer gives after paying (email, password, cookies...).
  if (body.afterFields !== undefined) {
    const fields = parseAfterFields(body.afterFields);
    if (!fields) throw new ApiError("invalid_input", "afterFields");
    out.after_fields = fields;
  }
  return out;
}

/** A package's warranty label ("Full warranty"), both languages or neither. */
function warrantyChanges(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, col] of [["warrantyAr", "warranty_ar"], ["warrantyEn", "warranty_en"]] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (v !== null && (typeof v !== "string" || v.trim().length > 40)) throw new ApiError("invalid_input", key);
    out[col] = typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : null;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── read

export async function getCatalog(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const db = ctx.svc.db;
  const categories = await db.query(`select id, slug, name_ar, name_en, sort, active from app.categories order by sort, slug`);
  const products = await db.query(
    `select id, slug, category_id, name_ar, name_en, description_ar, description_en, instructions_ar, instructions_en,
            warranty_ar, warranty_en, search_terms, image_url, cover_url, unit_ar, unit_en, kind, active, featured, sort,
            delivery, after_fields, badge, seo_title_ar, seo_title_en, seo_description_ar, seo_description_en
       from app.products order by sort, name_en`,
  );
  const offers = await db.query<Record<string, unknown> & { cost_cents: unknown; price_cents: unknown }>(
    `select o.id, o.product_id, o.name_ar, o.name_en, o.sort, o.supplier_id, o.supplier_ref, o.cost_cents, o.price_cents,
            o.markup_mode, o.markup_value, o.round_to_cents, o.min_margin_pct, o.input_fields, o.max_quantity, o.active,
            o.paused_reason, o.cost_checked_at, o.remind_after_days, o.warranty_ar, o.warranty_en, o.success_pct, o.pinned,
            (select count(*) from app.stock_items s where s.offer_id = o.id and s.status = 'available') as stock_available
       from app.offers o order by o.sort, o.price_cents`,
  );
  const suppliers = await db.query(
    `select id, name, enabled, low_balance_cents, balance_cents, case when 'down' in (health, sync_health) then 'down' when 'degraded' in (health, sync_health) then 'degraded' when 'ok' in (health, sync_health) then 'ok' else 'unknown' end as health, last_sync_at, coalesce(last_error, sync_error) as last_error,
            import_markup_pct, import_min_margin_pct, import_round_to_cents
       from app.suppliers order by id`,
  );
  return json({
    categories,
    products,
    offers: offers.map((o) => ({
      ...o,
      cost_cents: o.cost_cents === null ? null : n(o.cost_cents),
      price_cents: n(o.price_cents),
      stock_available: n(o.stock_available),
    })),
    suppliers,
  });
}

// ─────────────────────────────────────────────────────────────── write

export async function createCategory(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req);
  const slug = str(body, "slug", { max: 48, pattern: /^[a-z0-9-]{1,48}$/ });
  const rows = await call<{ id: string }>(
    ctx.svc.db,
    `insert into app.categories (slug, name_ar, name_en, sort) values ($1, $2, $3, $4) returning id`,
    [slug, str(body, "nameAr", { max: 40 }), str(body, "nameEn", { max: 40 }), optInt(body, "sort", -10_000, 10_000) ?? 0],
  );
  const id = rows[0]!.id;
  await audit(ctx.svc.db, { actor: staff.id, action: "category.create", targetType: "category", targetId: id, data: { slug } });
  return json({ id }, { status: 201 });
}

export async function createProduct(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req);
  for (const k of ["slug", "categoryId", "nameAr", "nameEn", "kind"]) if (body[k] === undefined) throw new ApiError("invalid_input", k);
  const c = productChanges(body);
  const cols = Object.keys(c);
  const rows = await call<{ id: string }>(
    ctx.svc.db,
    `insert into app.products (${cols.join(", ")})
     values (${cols.map((k, i) => (k === "after_fields" ? `$${i + 1}::text::jsonb` : `$${i + 1}`)).join(", ")}) returning id`,
    cols.map((k) => (k === "after_fields" ? JSON.stringify(c[k]) : c[k])),
  );
  const id = rows[0]!.id;
  await audit(ctx.svc.db, { actor: staff.id, action: "product.create", targetType: "product", targetId: id, data: { slug: c.slug } });
  return json({ id }, { status: 201 });
}

export async function updateProduct(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req, 65_536);
  const changes = productChanges(body);
  const before = await one<{ unit_ar: string; unit_en: string }>(ctx.svc.db, `select unit_ar, unit_en from app.products where id = $1`, [id]);
  await updateRow(ctx, "products", id, changes);
  const renamed = before ? await applyUnits(ctx, id, before, changes) : 0;
  await audit(ctx.svc.db, { actor: staff.id, action: "product.update", targetType: "product", targetId: id, data: { fields: Object.keys(changes), renamed } });
  return json({ ok: true, renamed });
}

/** The unit changed: rename this product's packages that are named by their amount ("60" ⇄ "60 UC"). */
async function applyUnits(ctx: Ctx, productId: string, before: { unit_ar: string; unit_en: string }, changes: Record<string, unknown>): Promise<number> {
  const ar = typeof changes.unit_ar === "string" ? changes.unit_ar : before.unit_ar;
  const en = typeof changes.unit_en === "string" ? changes.unit_en : before.unit_en;
  if (ar === before.unit_ar && en === before.unit_en) return 0;
  const offers = await ctx.svc.db.query<{ id: string; name_ar: string; name_en: string }>(`select id, name_ar, name_en from app.offers where product_id = $1`, [productId]);
  let renamed = 0;
  for (const o of offers) {
    const nameAr = withUnit(o.name_ar, ar, before.unit_ar);
    const nameEn = withUnit(o.name_en, en, before.unit_en);
    if (nameAr === o.name_ar && nameEn === o.name_en) continue;
    await ctx.svc.db.query(`update app.offers set name_ar = $2, name_en = $3 where id = $1`, [o.id, nameAr, nameEn]);
    renamed++;
  }
  return renamed;
}

export interface OfferPricing {
  mode: MarkupMode;
  value: number;
  roundToCents: number;
  minMarginPct: number;
}

/** The price an offer should have: computed from cost, or the manual price checked against the margin floor. */
export function resolvePrice(cost: number | null, p: OfferPricing, manualPrice: number | undefined): number {
  if (p.mode === "manual") {
    if (manualPrice === undefined) throw new ApiError("invalid_input", "priceCents");
    if (cost !== null && manualPrice < minimumPrice(cost, p.minMarginPct)) throw new ApiError("invalid_input", "priceCents");
    return manualPrice;
  }
  if (cost === null) throw new ApiError("invalid_input", "costCents");
  return priceFromCost(cost, { mode: p.mode, value: p.value, roundToCents: p.roundToCents, minMarginPct: p.minMarginPct });
}

function pricingFrom(body: Record<string, unknown>, base?: OfferPricing): OfferPricing {
  const mode = body.markupMode === undefined ? base?.mode ?? "percent" : (str(body, "markupMode", { max: 10 }) as MarkupMode);
  if (!MODES.includes(mode)) throw new ApiError("invalid_input", "markupMode");
  return {
    mode,
    value: optNum(body, "markupValue", 0, mode === "fixed" ? 100_000 : 1000) ?? base?.value ?? 15,
    roundToCents: optInt(body, "roundToCents", 1, 10_000) ?? base?.roundToCents ?? 1,
    minMarginPct: optNum(body, "minMarginPct", 0, 500) ?? base?.minMarginPct ?? 5,
  };
}

export async function createOffer(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const productId = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const supplierId = optStr(body, "supplierId", { max: 32 }) ?? null;
  if (supplierId !== null && !SUPPLIER_ID.test(supplierId)) throw new ApiError("invalid_input", "supplierId");
  const supplierRef = supplierId ? str(body, "supplierRef", { max: 120 }) : null;
  const cost = optInt(body, "costCents", 0, 10_000_000) ?? null;
  const pricing = pricingFrom(body);
  const price = resolvePrice(cost, pricing, optInt(body, "priceCents", 1, 10_000_000));
  const fields = body.inputFields === undefined ? [] : parseInputFields(body.inputFields);
  const warranty = warrantyChanges(body);
  const rows = await call<{ id: string }>(
    ctx.svc.db,
    `insert into app.offers (product_id, name_ar, name_en, sort, supplier_id, supplier_ref, cost_cents, price_cents,
                             markup_mode, markup_value, round_to_cents, min_margin_pct, input_fields, max_quantity, active,
                             remind_after_days, cost_checked_at, warranty_ar, warranty_en)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::jsonb, $14, $15, $16,
             case when $7::bigint is null then null else now() end, $17, $18)
     returning id`,
    [
      productId, str(body, "nameAr", { max: 120 }), str(body, "nameEn", { max: 120 }), optInt(body, "sort", -10_000, 10_000) ?? 0,
      supplierId, supplierRef, cost, price, pricing.mode, pricing.value, pricing.roundToCents, pricing.minMarginPct,
      JSON.stringify(fields), optInt(body, "maxQuantity", 1, 100) ?? 1, bool(body, "active") ?? true,
      optInt(body, "remindAfterDays", 1, 365) ?? null, warranty.warranty_ar ?? null, warranty.warranty_en ?? null,
    ],
  );
  const id = rows[0]!.id;
  await audit(ctx.svc.db, { actor: staff.id, action: "offer.create", targetType: "offer", targetId: id, data: { productId, supplierId, supplierRef, price } });
  return json({ id, priceCents: price }, { status: 201 });
}

export async function updateOffer(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const cur = await must<{ supplier_id: string | null; cost_cents: string | number | null; price_cents: string | number; markup_mode: MarkupMode; markup_value: string | number; round_to_cents: number; min_margin_pct: string | number }>(
    ctx.svc.db,
    `select supplier_id, cost_cents, price_cents, markup_mode, markup_value, round_to_cents, min_margin_pct from app.offers where id = $1`,
    [id],
  );
  const changes: Record<string, unknown> = {};
  // Supplier costs come from the supplier sync; only manual-stock packages take a typed cost.
  let costCents = cur.cost_cents === null ? null : n(cur.cost_cents);
  if (body.costCents !== undefined) {
    if (cur.supplier_id !== null) throw new ApiError("invalid_input", "costCents");
    costCents = body.costCents === null ? null : int(body, "costCents", 0, 10_000_000);
    changes.cost_cents = costCents;
  }
  if (body.nameAr !== undefined) changes.name_ar = str(body, "nameAr", { max: 120 });
  if (body.nameEn !== undefined) changes.name_en = str(body, "nameEn", { max: 120 });
  const sort = optInt(body, "sort", -10_000, 10_000);
  if (sort !== undefined) changes.sort = sort;
  const maxQ = optInt(body, "maxQuantity", 1, 100);
  if (maxQ !== undefined) changes.max_quantity = maxQ;
  const active = bool(body, "active");
  if (active !== undefined) changes.active = active;
  // "Buy again" reminder after this many days (null turns it off).
  if (body.remindAfterDays !== undefined) changes.remind_after_days = body.remindAfterDays === null ? null : int(body, "remindAfterDays", 1, 365);
  if (body.inputFields !== undefined) changes.input_fields = parseInputFields(body.inputFields);
  Object.assign(changes, warrantyChanges(body));
  // Listed first in its product (virtual numbers: the owner's favourite countries).
  const pinned = bool(body, "pinned");
  if (pinned !== undefined) changes.pinned = pinned;
  // Clearing a system pause is an explicit decision; the next sync pauses again if still needed.
  if (bool(body, "clearPause")) changes.paused_reason = null;

  const touchesPrice = ["markupMode", "markupValue", "roundToCents", "minMarginPct", "priceCents", "costCents"].some((k) => body[k] !== undefined);
  if (touchesPrice) {
    const base: OfferPricing = { mode: cur.markup_mode, value: Number(cur.markup_value), roundToCents: cur.round_to_cents, minMarginPct: Number(cur.min_margin_pct) };
    const p = pricingFrom(body, base);
    const cost = costCents;
    const manual = optInt(body, "priceCents", 1, 10_000_000) ?? (p.mode === "manual" ? n(cur.price_cents) : undefined);
    const price = resolvePrice(cost, p, manual);
    Object.assign(changes, { markup_mode: p.mode, markup_value: p.value, round_to_cents: p.roundToCents, min_margin_pct: p.minMarginPct, price_cents: price });
    if (price !== n(cur.price_cents)) {
      await ctx.svc.db.query(
        `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $5, 'manual')`,
        [id, cur.cost_cents === null ? null : n(cur.cost_cents), cost, n(cur.price_cents), price],
      );
    }
  }
  await updateRow(ctx, "offers", id, changes);
  await audit(ctx.svc.db, { actor: staff.id, action: "offer.update", targetType: "offer", targetId: id, data: { fields: Object.keys(changes) } });
  if (changes.paused_reason === null || changes.active === true) await notifyBackInStock(ctx.svc, [id]);
  return json({ ok: true, priceCents: (changes.price_cents as number | undefined) ?? n(cur.price_cents) });
}

/** Upload codes/accounts for a manual-stock offer, one item per entry. Stored encrypted. */
export async function addStock(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req, 262_144);
  const items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) throw new ApiError("invalid_input", "items");
  const clean = items.map((v) => {
    if (typeof v !== "string" || !v.trim() || v.length > 2000) throw new ApiError("invalid_input", "items");
    return v.trim();
  });
  const key = ctx.env.DATA_KEY;
  if (typeof key !== "string" || !key) throw new ApiError("bad_state");
  await must(ctx.svc.db, `select id from app.offers where id = $1 and supplier_id is null`, [id], "bad_state");
  const sealed = await Promise.all(clean.map((v) => encryptText(v, key)));
  await ctx.svc.db.query(
    `insert into app.stock_items (offer_id, payload_enc) select $1, x from unnest(string_to_array($2::text, chr(10))) as x`,
    [id, sealed.join("\n")],
  );
  await audit(ctx.svc.db, { actor: staff.id, action: "stock.add", targetType: "offer", targetId: id, data: { count: clean.length } });
  // Codes again: tell whoever waited for this package.
  await notifyBackInStock(ctx.svc, [id]);
  return json({ added: clean.length }, { status: 201 });
}

/**
 * Point an existing supplier package at another item of the same supplier, for
 * when the supplier renumbers its catalogue (BatStore did when it moved). The
 * package keeps its product, names, fields and history; its cost becomes the
 * new item's and its price follows its pricing rule (a manual price must still
 * clear the margin). The sync's own pause is lifted; a staff pause stays.
 */
export async function relinkOffer(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const supplierRef = str(body, "supplierRef", { max: 120 });
  const cost = int(body, "costCents", 1, 10_000_000);
  const cur = await must<{ supplier_id: string | null; supplier_ref: string | null; cost_cents: string | number | null; price_cents: string | number; markup_mode: MarkupMode; markup_value: string | number; round_to_cents: number; min_margin_pct: string | number }>(
    ctx.svc.db,
    `select supplier_id, supplier_ref, cost_cents, price_cents, markup_mode, markup_value, round_to_cents, min_margin_pct from app.offers where id = $1`,
    [id],
  );
  if (!cur.supplier_id) throw new ApiError("bad_state", "supplier");
  const taken = await one(ctx.svc.db, `select 1 from app.offers where supplier_id = $1 and supplier_ref = $2 and id <> $3`, [cur.supplier_id, supplierRef, id]);
  if (taken) throw new ApiError("conflict", "supplierRef");
  const rule: OfferPricing = { mode: cur.markup_mode, value: Number(cur.markup_value), roundToCents: cur.round_to_cents, minMarginPct: Number(cur.min_margin_pct) };
  const price = resolvePrice(cost, rule, rule.mode === "manual" ? n(cur.price_cents) : undefined);
  await ctx.svc.db.query(
    `update app.offers set supplier_ref = $2, cost_cents = $3, price_cents = $4, cost_checked_at = now(),
            paused_reason = case when paused_reason in ('supplier_unavailable', 'cost_above_margin') then null else paused_reason end
      where id = $1`,
    [id, supplierRef, cost, price],
  );
  // What this supplier sells changed: a "Choose packages" screen loaded before must reload.
  await ctx.svc.db.query(`update app.suppliers set selection_version = selection_version + 1 where id = $1`, [cur.supplier_id]);
  if (price !== n(cur.price_cents) || cost !== (cur.cost_cents === null ? null : n(cur.cost_cents))) {
    await ctx.svc.db.query(
      `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $5, 'manual')`,
      [id, cur.cost_cents === null ? null : n(cur.cost_cents), cost, n(cur.price_cents), price],
    );
  }
  await audit(ctx.svc.db, { actor: staff.id, action: "offer.relink", targetType: "offer", targetId: id, data: { supplierId: cur.supplier_id, from: cur.supplier_ref, to: supplierRef, cost, price } });
  return json({ ok: true, priceCents: price });
}
