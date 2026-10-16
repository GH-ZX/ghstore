/**
 * Admin catalogue: categories, products, offers (packages), manual stock and
 * supplier settings. Owner only. Every change is written to app.audit_log.
 *
 * Importing from a supplier: GET /api/admin/suppliers/:id/products lists what the
 * supplier sells (and which items are already linked); the admin then creates an
 * offer with that supplierRef. The hourly sync keeps cost and price in line.
 */
import { encryptText, minimumPrice, priceFromCost, type InputField, type MarkupMode } from "@store/core";
import { requireStaff } from "./auth";
import type { Ctx } from "./context";
import { call, must, n, one } from "./db";
import { ApiError, int, json, optStr, readJson, str, uuid } from "./http";

const SLUG = /^[a-z0-9-]{1,80}$/;
const SUPPLIER_ID = /^[a-z0-9_]{2,32}$/;
const KINDS = ["id", "code", "account", "link", "sms"] as const;
const MODES: MarkupMode[] = ["percent", "fixed", "manual"];

async function audit(ctx: Ctx, actor: string, action: string, targetType: string, targetId: string, data: Record<string, unknown> = {}) {
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, $2, $3, $4, $5::text::jsonb)`,
    [actor, action, targetType, targetId, JSON.stringify(data)],
  );
}

function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ApiError("invalid_input", key);
  return v;
}

function optInt(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  return body[key] === undefined || body[key] === null ? undefined : int(body, key, min, max);
}

function optNum(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ApiError("invalid_input", key);
  return Math.round(v * 100) / 100;
}

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
  for (const [key, col] of [["active", "active"], ["featured", "featured"]] as const) {
    const v = bool(body, key);
    if (v !== undefined) out[col] = v;
  }
  const sort = optInt(body, "sort", -10_000, 10_000);
  if (sort !== undefined) out.sort = sort;
  return out;
}

/** Build `update ... set a = $2, b = $3` from a column map. Column names come from our own lists only. */
async function updateRow(ctx: Ctx, table: string, id: string, changes: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(changes);
  if (!cols.length) throw new ApiError("bad_request");
  const sets = cols.map((c, i) => (c === "input_fields" ? `${c} = $${i + 2}::text::jsonb` : `${c} = $${i + 2}`));
  const params = cols.map((c) => (c === "input_fields" ? JSON.stringify(changes[c]) : changes[c]));
  const rows = await call(ctx.svc.db, `update app.${table} set ${sets.join(", ")} where id = $1 returning id`, [id, ...params]);
  if (!rows.length) throw new ApiError("not_found");
}

// ─────────────────────────────────────────────────────────────── read

export async function getCatalog(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const db = ctx.svc.db;
  const categories = await db.query(`select id, slug, name_ar, name_en, sort, active from app.categories order by sort, slug`);
  const products = await db.query(
    `select id, slug, category_id, name_ar, name_en, description_ar, description_en, instructions_ar, instructions_en,
            warranty_ar, warranty_en, search_terms, image_url, kind, active, featured, sort
       from app.products order by sort, name_en`,
  );
  const offers = await db.query<Record<string, unknown> & { cost_cents: unknown; price_cents: unknown }>(
    `select o.id, o.product_id, o.name_ar, o.name_en, o.sort, o.supplier_id, o.supplier_ref, o.cost_cents, o.price_cents,
            o.markup_mode, o.markup_value, o.round_to_cents, o.min_margin_pct, o.input_fields, o.max_quantity, o.active,
            o.paused_reason, o.cost_checked_at, o.remind_after_days,
            (select count(*) from app.stock_items s where s.offer_id = o.id and s.status = 'available') as stock_available
       from app.offers o order by o.sort, o.price_cents`,
  );
  const suppliers = await db.query(
    `select id, name, enabled, low_balance_cents, balance_cents, health, last_sync_at, last_error,
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

/** What a supplier sells right now, with the offer each item is linked to (if any). */
export async function listSupplierProducts(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const id = ctx.params.id ?? "";
  if (!SUPPLIER_ID.test(id)) throw new ApiError("not_found");
  const adapter = ctx.svc.supplier(id);
  if (!adapter) throw new ApiError("bad_state");
  // Big catalogues (G2Bulk) are listed one group at a time: first the groups, then one group's items.
  const group = new URL(ctx.req.url).searchParams.get("group");
  if (group !== null && !/^[A-Za-z0-9:_.-]{1,80}$/.test(group)) throw new ApiError("invalid_input", "group");
  if (adapter.listGroups && !group) {
    return json({ supplier: id, groups: await adapter.listGroups(), items: [] });
  }
  const items = await adapter.listProducts(group ?? undefined);
  const linked = await ctx.svc.db.query<{ id: string; supplier_ref: string }>(`select id, supplier_ref from app.offers where supplier_id = $1`, [id]);
  const byRef = new Map(linked.map((l) => [l.supplier_ref, l.id]));
  return json({
    supplier: id,
    items: items.map((p) => ({ ...p, offerId: byRef.get(p.externalId) ?? null })),
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
  await audit(ctx, staff.id, "category.create", "category", id, { slug });
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
    `insert into app.products (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    cols.map((k) => c[k]),
  );
  const id = rows[0]!.id;
  await audit(ctx, staff.id, "product.create", "product", id, { slug: c.slug });
  return json({ id }, { status: 201 });
}

export async function updateProduct(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req, 65_536);
  const changes = productChanges(body);
  await updateRow(ctx, "products", id, changes);
  await audit(ctx, staff.id, "product.update", "product", id, { fields: Object.keys(changes) });
  return json({ ok: true });
}

interface OfferPricing {
  mode: MarkupMode;
  value: number;
  roundToCents: number;
  minMarginPct: number;
}

/** The price an offer should have: computed from cost, or the manual price checked against the margin floor. */
function resolvePrice(cost: number | null, p: OfferPricing, manualPrice: number | undefined): number {
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
  const rows = await call<{ id: string }>(
    ctx.svc.db,
    `insert into app.offers (product_id, name_ar, name_en, sort, supplier_id, supplier_ref, cost_cents, price_cents,
                             markup_mode, markup_value, round_to_cents, min_margin_pct, input_fields, max_quantity, active,
                             remind_after_days, cost_checked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::jsonb, $14, $15, $16,
             case when $7::bigint is null then null else now() end)
     returning id`,
    [
      productId, str(body, "nameAr", { max: 120 }), str(body, "nameEn", { max: 120 }), optInt(body, "sort", -10_000, 10_000) ?? 0,
      supplierId, supplierRef, cost, price, pricing.mode, pricing.value, pricing.roundToCents, pricing.minMarginPct,
      JSON.stringify(fields), optInt(body, "maxQuantity", 1, 100) ?? 1, bool(body, "active") ?? true,
      optInt(body, "remindAfterDays", 1, 365) ?? null,
    ],
  );
  const id = rows[0]!.id;
  await audit(ctx, staff.id, "offer.create", "offer", id, { productId, supplierId, supplierRef, price });
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
  await audit(ctx, staff.id, "offer.update", "offer", id, { fields: Object.keys(changes) });
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
  await audit(ctx, staff.id, "stock.add", "offer", id, { count: clean.length });
  return json({ added: clean.length }, { status: 201 });
}

export async function updateSupplier(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = ctx.params.id ?? "";
  if (!SUPPLIER_ID.test(id)) throw new ApiError("not_found");
  const body = await readJson(ctx.req);
  const changes: Record<string, unknown> = {};
  const enabled = bool(body, "enabled");
  if (enabled !== undefined) changes.enabled = enabled;
  const low = optInt(body, "lowBalanceCents", 0, 100_000_000);
  if (low !== undefined) changes.low_balance_cents = low;
  if (body.name !== undefined) changes.name = str(body, "name", { max: 60 });
  // How the price check behaves (see app.suppliers in migration 0016).
  const every = optInt(body, "syncMinutes", 15, 1440);
  if (every !== undefined) changes.sync_minutes = every;
  const auto = bool(body, "autoReprice");
  if (auto !== undefined) changes.auto_reprice = auto;
  if (body.maxJumpPct !== undefined) changes.max_jump_pct = body.maxJumpPct === null ? null : int(body, "maxJumpPct", 5, 1000);
  const markup = optNum(body, "importMarkupPct", 0, 1000);
  if (markup !== undefined) changes.import_markup_pct = markup;
  const margin = optNum(body, "importMinMarginPct", 0, 500);
  if (margin !== undefined) changes.import_min_margin_pct = margin;
  const round = optInt(body, "importRoundToCents", 1, 10_000);
  if (round !== undefined) changes.import_round_to_cents = round;
  await updateRow(ctx, "suppliers", id, changes);
  await audit(ctx, staff.id, "supplier.update", "supplier", id, changes);
  return json({ ok: true });
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
  if (price !== n(cur.price_cents) || cost !== (cur.cost_cents === null ? null : n(cur.cost_cents))) {
    await ctx.svc.db.query(
      `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $5, 'manual')`,
      [id, cur.cost_cents === null ? null : n(cur.cost_cents), cost, n(cur.price_cents), price],
    );
  }
  await audit(ctx, staff.id, "offer.relink", "offer", id, { supplierId: cur.supplier_id, from: cur.supplier_ref, to: supplierRef, cost, price });
  return json({ ok: true, priceCents: price });
}

// ─────────────────────────────────────────────────────────────── suppliers page

/**
 * Admin → Suppliers: each supplier with its settings, balance, what it sells,
 * what is paused and why, and what the last price check did.
 */
export async function listSuppliers(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const rows = await ctx.svc.db.query<Record<string, unknown>>(
    `select s.id, s.name, s.enabled, s.health, s.last_error, s.balance_cents, s.balance_checked_at, s.low_balance_cents,
            s.last_sync_at, s.sync_minutes, s.auto_reprice, s.max_jump_pct, s.import_markup_pct, s.import_min_margin_pct,
            s.import_round_to_cents, s.last_sync_report,
            count(o.id) filter (where o.active) as packages,
            count(o.id) filter (where o.active and o.paused_reason is null) as selling,
            count(o.id) filter (where o.active and o.paused_reason = 'supplier_unavailable') as unavailable,
            count(o.id) filter (where o.active and o.paused_reason = 'cost_above_margin') as below_margin,
            count(o.id) filter (where o.active and o.paused_reason = 'cost_jump') as cost_jump,
            count(o.id) filter (where o.active and o.paused_reason is not null
                                  and o.paused_reason not in ('supplier_unavailable', 'cost_above_margin', 'cost_jump')) as paused_by_staff,
            count(o.id) filter (where o.active and (o.cost_checked_at is null or o.cost_checked_at <= coalesce(s.last_sync_at, now() - interval '1 hour'))) as not_checked
       from app.suppliers s left join app.offers o on o.supplier_id = s.id
      group by s.id order by s.enabled desc, s.name`,
  );
  const num = (v: unknown) => (v === null || v === undefined ? null : n(v));
  return json({
    suppliers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      health: r.health,
      lastError: r.last_error,
      balanceCents: num(r.balance_cents),
      balanceCheckedAt: r.balance_checked_at,
      lowBalanceCents: num(r.low_balance_cents),
      lastSyncAt: r.last_sync_at,
      syncMinutes: r.sync_minutes,
      autoReprice: r.auto_reprice,
      maxJumpPct: r.max_jump_pct === null ? null : Number(r.max_jump_pct),
      importMarkupPct: Number(r.import_markup_pct),
      importMinMarginPct: Number(r.import_min_margin_pct),
      importRoundToCents: Number(r.import_round_to_cents),
      lastReport: r.last_sync_report ?? null,
      counts: {
        packages: n(r.packages),
        selling: n(r.selling),
        unavailable: n(r.unavailable),
        belowMargin: n(r.below_margin),
        costJump: n(r.cost_jump),
        pausedByStaff: n(r.paused_by_staff),
        notChecked: n(r.not_checked),
      },
    })),
  });
}

/** The paused packages of one supplier, for Admin → Suppliers → Review. */
export async function supplierReview(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const id = ctx.params.id ?? "";
  if (!SUPPLIER_ID.test(id)) throw new ApiError("not_found");
  const rows = await ctx.svc.db.query<Record<string, unknown>>(
    `select o.id, o.supplier_ref, o.name_ar, o.name_en, o.paused_reason, o.cost_cents, o.pending_cost_cents, o.price_cents,
            o.markup_mode, o.min_margin_pct, o.cost_checked_at, p.id as product_id, p.slug, p.name_ar as product_ar, p.name_en as product_en
       from app.offers o join app.products p on p.id = o.product_id
      where o.supplier_id = $1 and o.active and o.paused_reason is not null
      order by case o.paused_reason when 'cost_jump' then 0 when 'cost_above_margin' then 1 when 'supplier_unavailable' then 2 else 3 end,
               p.name_en, o.sort`,
    [id],
  );
  const num = (v: unknown) => (v === null || v === undefined ? null : n(v));
  return json({
    packages: rows.map((r) => ({
      id: r.id,
      supplierRef: r.supplier_ref,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      productId: r.product_id,
      productAr: r.product_ar,
      productEn: r.product_en,
      reason: r.paused_reason,
      costCents: num(r.cost_cents),
      pendingCostCents: num(r.pending_cost_cents),
      priceCents: num(r.price_cents),
      markupMode: r.markup_mode,
      minMarginPct: Number(r.min_margin_pct),
      checkedAt: r.cost_checked_at,
    })),
  });
}

/**
 * Review → "Accept new cost" on a package paused because its cost jumped: the
 * cost becomes the supplier's new one and the price follows the package's rule.
 * A manual price that no longer clears the margin stays paused for a new price.
 */
export async function acceptCost(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = uuid(ctx.params.id);
  const cur = await must<{ paused_reason: string | null; cost_cents: string | number | null; pending_cost_cents: string | number | null; price_cents: string | number; markup_mode: MarkupMode; markup_value: string | number; round_to_cents: number; min_margin_pct: string | number }>(
    ctx.svc.db,
    `select paused_reason, cost_cents, pending_cost_cents, price_cents, markup_mode, markup_value, round_to_cents, min_margin_pct from app.offers where id = $1`,
    [id],
  );
  if (cur.paused_reason !== "cost_jump" || cur.pending_cost_cents === null) throw new ApiError("bad_state", "cost_jump");
  const cost = n(cur.pending_cost_cents);
  const old = n(cur.price_cents);
  const rule: OfferPricing = { mode: cur.markup_mode, value: Number(cur.markup_value), roundToCents: cur.round_to_cents, minMarginPct: Number(cur.min_margin_pct) };
  const marginOk = rule.mode !== "manual" || old >= minimumPrice(cost, rule.minMarginPct);
  const price = rule.mode === "manual" ? old : resolvePrice(cost, rule, undefined);
  await ctx.svc.db.query(
    `update app.offers set cost_cents = $2, price_cents = $3, pending_cost_cents = null, cost_checked_at = now(),
            paused_reason = case when $4 then null else 'cost_above_margin' end
      where id = $1`,
    [id, cost, price, marginOk],
  );
  await ctx.svc.db.query(
    `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $5, 'manual')`,
    [id, cur.cost_cents === null ? null : n(cur.cost_cents), cost, old, price],
  );
  await audit(ctx, staff.id, "offer.accept_cost", "offer", id, { cost, price, selling: marginOk });
  return json({ ok: true, priceCents: price, selling: marginOk });
}
