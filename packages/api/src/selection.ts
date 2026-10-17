/**
 * Admin → Suppliers → Choose packages → Apply: sell exactly what the owner ticked.
 *
 * POST /api/admin/suppliers/:id/selection
 *   { version, add: [ref], remove: [ref], dryRun?,
 *     place?: { [destination]: { productId } | { categoryId, nameAr?, nameEn?, unitAr?, unitEn? } } }
 *
 * - Every item is checked against the saved copy of the supplier's list
 *   (supplier-catalogue.ts); one it does not list, or lists as unavailable, is refused.
 * - New packages go to a destination: the supplier's suggested product
 *   ("p:<productKey>", e.g. a G2Bulk game) or, for items that are products of
 *   their own (BatStore), "i:<ref>". A destination already sold by the store
 *   joins its product; otherwise a new product is made (shown at once, in the
 *   supplier's import category or where its products of that kind usually
 *   are, with its description template). `place` moves a
 *   destination into an existing product, or names a new one (Arabic and
 *   English), puts it in another category and gives it a unit.
 * - Packages named only by their amount take the product's unit ("60" → "60 UC").
 * - New packages are priced with the supplier's import defaults and always clear
 *   the margin guard.
 * - Removing: a package never ordered is deleted; one with orders is archived
 *   (hidden, kept for order history and refunds). A product left with nothing
 *   to sell is hidden. Ticking an archived package again brings it back.
 * - `version` is the supplier's selection_version the screen loaded; anything
 *   else is refused (conflict "version"), so two people cannot undo each other.
 * - One transaction, owner only, audit logged. dryRun returns the same plan
 *   without changing anything.
 */
import { priceFromCost, withUnit, type InputField } from "@store/core";
import { parseInputFields } from "./admin-catalog";
import { audit } from "./audit";
import { requireStaff } from "./auth";
import type { Ctx } from "./context";
import type { Db } from "./db";
import { n } from "./db";
import { ApiError, int, json, readJson } from "./http";
import { checkSupplierId } from "./supplier-catalogue";

/** At most this many changes in one apply. */
export const MAX_CHANGES = 500;
const REF = /^[^\u0000-\u001f]{1,120}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Item {
  external_id: string;
  name: string;
  product_key: string | null;
  product_name: string | null;
  product_name_ar: string | null;
  package_name: string | null;
  package_name_ar: string | null;
  warranty_en: string | null;
  warranty_ar: string | null;
  success_pct: string | number | null;
  cost_cents: string | number;
  available: boolean;
  missing: boolean;
  kind: string;
  fields: unknown;
}

interface Offer {
  id: string;
  supplier_ref: string;
  name_ar: string;
  name_en: string;
  active: boolean;
  product_id: string;
  product_ar: string;
  product_en: string;
  product_active: boolean;
  has_orders: boolean;
}

interface Destination {
  key: string;
  productId: string | null;
  categoryId: string | null;
  nameAr: string;
  nameEn: string;
  unitAr: string;
  unitEn: string;
  kind: string;
  isNew: boolean;
  items: {
    ref: string; name: string; nameAr: string; costCents: number; priceCents: number; fields: InputField[];
    warrantyEn: string | null; warrantyAr: string | null; successPct: number | null; reactivate?: string;
  }[];
}

/** A name typed in the review step: 1-120 characters. */
function typedName(v: unknown, key: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !v.trim() || v.trim().length > 120) throw new ApiError("invalid_input", key);
  return v.replace(/\s+/g, " ").trim();
}

function typedUnit(v: unknown, key: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim().length > 24) throw new ApiError("invalid_input", key);
  return v.replace(/\s+/g, " ").trim();
}

function refs(body: Record<string, unknown>, key: string): string[] {
  const v = body[key] ?? [];
  if (!Array.isArray(v)) throw new ApiError("invalid_input", key);
  const out = new Set<string>();
  for (const r of v) {
    if (typeof r !== "string" || !REF.test(r)) throw new ApiError("invalid_input", key);
    out.add(r);
  }
  return [...out];
}

function slugBase(name: string, fallback: string): string {
  const s = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s.length >= 2 ? s : fallback;
}

/** A short, stable suffix for products whose name has no Latin letters. */
function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

async function uniqueSlug(db: Db, base: string): Promise<string> {
  const taken = new Set(
    (await db.query<{ slug: string }>(`select slug from app.products where slug = $1 or slug like $1 || '-%'`, [base])).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export async function applySelection(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const supplierId = checkSupplierId(ctx.params.id);
  const body = await readJson(ctx.req, 262_144);
  const version = int(body, "version", 0, 2_000_000_000);
  const add = refs(body, "add");
  const remove = refs(body, "remove");
  const dryRun = body.dryRun === true;
  if (add.length + remove.length === 0) throw new ApiError("invalid_input", "add");
  if (add.length + remove.length > MAX_CHANGES) throw new ApiError("invalid_input", "add");
  if (add.some((r) => remove.includes(r))) throw new ApiError("invalid_input", "remove");
  const place = body.place ?? {};
  if (typeof place !== "object" || place === null || Array.isArray(place)) throw new ApiError("invalid_input", "place");

  const run = async (db: Db) => {
    const sup = (
      await db.query<{ selection_version: number; import_markup_pct: string | number; import_min_margin_pct: string | number; import_round_to_cents: number; import_category_id: string | null; import_description_ar: string; import_description_en: string }>(
        `select selection_version, import_markup_pct, import_min_margin_pct, import_round_to_cents, import_category_id,
                import_description_ar, import_description_en
           from app.suppliers where id = $1 for update`,
        [supplierId],
      )
    )[0];
    if (!sup) throw new ApiError("not_found");
    if (sup.selection_version !== version) throw new ApiError("conflict", "version");
    const rule = {
      mode: "percent" as const,
      value: Number(sup.import_markup_pct),
      roundToCents: Number(sup.import_round_to_cents),
      minMarginPct: Number(sup.import_min_margin_pct),
    };

    const all = [...add, ...remove];
    const items = new Map(
      (
        await db.query<Item>(
          `select external_id, name, product_key, product_name, product_name_ar, package_name, package_name_ar, warranty_en, warranty_ar,
                  success_pct, cost_cents, available,
                  missing_since is not null as missing, kind, fields
             from app.supplier_items where supplier_id = $1 and external_id in (select jsonb_array_elements_text($2::text::jsonb))`,
          [supplierId, JSON.stringify(add)],
        )
      ).map((i) => [i.external_id, i]),
    );
    const offers = new Map(
      (
        await db.query<Offer>(
          `select o.id, o.supplier_ref, o.name_ar, o.name_en, o.active, o.product_id, p.name_ar as product_ar, p.name_en as product_en,
                  p.active as product_active, exists (select 1 from app.orders r where r.offer_id = o.id) as has_orders
             from app.offers o join app.products p on p.id = o.product_id
            where o.supplier_id = $1 and o.supplier_ref in (select jsonb_array_elements_text($2::text::jsonb))`,
          [supplierId, JSON.stringify(all)],
        )
      ).map((o) => [o.supplier_ref, o]),
    );
    const categories = await db.query<{ id: string }>(`select id from app.categories order by sort, slug`);
    const categoryIds = new Set(categories.map((c) => c.id));
    // New products go to the supplier's import category; without one, where its
    // products of the same kind usually are (G2Bulk: top-ups in Games, codes in
    // Vouchers), then where any of its products are, then the first category.
    const usual = await db.query<{ category_id: string; kind: string; n: string | number }>(
      `select p.category_id, p.kind, count(*) as n from app.offers o join app.products p on p.id = o.product_id
        where o.supplier_id = $1 group by p.category_id, p.kind order by count(*) desc`,
      [supplierId],
    );
    const categoryFor = (kind: string): string | null => {
      if (sup.import_category_id && categoryIds.has(sup.import_category_id)) return sup.import_category_id;
      return usual.find((u) => u.kind === kind)?.category_id ?? usual[0]?.category_id ?? categories[0]?.id ?? null;
    };

    // ── additions, by destination
    const dests = new Map<string, Destination>();
    const productNames = new Map<string, { ar: string; en: string; active: boolean }>();
    for (const ref of add) {
      const item = items.get(ref);
      const offer = offers.get(ref);
      if (offer?.active) continue; // already sold: nothing to do
      if (!item || item.missing || !item.available) throw new ApiError("invalid_input", `item:${ref}`);
      const cost = n(item.cost_cents);
      let fields: InputField[];
      try {
        fields = parseInputFields(item.fields ?? []);
      } catch {
        throw new ApiError("invalid_input", `fields:${ref}`);
      }
      const entry = {
        ref,
        name: item.package_name || item.name,
        nameAr: item.package_name_ar || item.package_name || item.name,
        costCents: cost,
        priceCents: priceFromCost(cost, rule),
        fields,
        warrantyEn: item.warranty_en,
        warrantyAr: item.warranty_ar,
        successPct: item.success_pct === null ? null : Number(item.success_pct),
      };
      if (offer) {
        // Archived earlier: the same package comes back, in its own product.
        const key = `o:${offer.product_id}`;
        const d = dests.get(key) ?? { key, productId: offer.product_id, categoryId: null, nameAr: offer.product_ar, nameEn: offer.product_en, unitAr: "", unitEn: "", kind: item.kind, isNew: false, items: [] };
        d.items.push({ ...entry, name: offer.name_en, nameAr: offer.name_ar, reactivate: offer.id });
        dests.set(key, d);
        productNames.set(offer.product_id, { ar: offer.product_ar, en: offer.product_en, active: offer.product_active });
        continue;
      }
      const key = item.product_key ? `p:${item.product_key}` : `i:${ref}`;
      let d = dests.get(key);
      if (!d) {
        const name = (item.product_key ? item.product_name : item.name) || item.name;
        const nameAr = (item.product_key ? item.product_name_ar : null) || name;
        d = { key, productId: null, categoryId: categoryFor(item.kind), nameAr: nameAr.slice(0, 120), nameEn: name.slice(0, 120), unitAr: "", unitEn: "", kind: item.kind, isNew: true, items: [] };
        const choice = (place as Record<string, unknown>)[key];
        if (choice !== undefined) {
          const c = (choice ?? {}) as Record<string, unknown>;
          if (typeof c.productId === "string" && UUID.test(c.productId)) {
            d.productId = c.productId;
          } else {
            if (c.categoryId !== undefined) {
              if (typeof c.categoryId !== "string" || !categoryIds.has(c.categoryId)) throw new ApiError("invalid_input", `place:${key}`);
              d.categoryId = c.categoryId;
            }
            d.nameAr = typedName(c.nameAr, `place:${key}`) ?? d.nameAr;
            d.nameEn = typedName(c.nameEn, `place:${key}`) ?? d.nameEn;
            d.unitAr = typedUnit(c.unitAr, `place:${key}`) ?? d.unitAr;
            d.unitEn = typedUnit(c.unitEn, `place:${key}`) ?? d.unitEn;
          }
        } else if (item.product_key) {
          // The store already sells this supplier group: join that product.
          const existing = await db.query<{ product_id: string }>(
            `select o.product_id from app.offers o
               join app.supplier_items i on i.supplier_id = o.supplier_id and i.external_id = o.supplier_ref
              where o.supplier_id = $1 and i.product_key = $2
              group by o.product_id order by bool_or(o.active) desc, count(*) desc limit 1`,
            [supplierId, item.product_key],
          );
          if (existing[0]) d.productId = existing[0].product_id;
        }
        if (d.productId) {
          const p = (await db.query<{ name_ar: string; name_en: string; active: boolean; unit_ar: string; unit_en: string }>(
            `select name_ar, name_en, active, unit_ar, unit_en from app.products where id = $1`,
            [d.productId],
          ))[0];
          if (!p) throw new ApiError("invalid_input", `place:${key}`);
          d.isNew = false;
          d.categoryId = null;
          d.nameAr = p.name_ar;
          d.nameEn = p.name_en;
          d.unitAr = p.unit_ar;
          d.unitEn = p.unit_en;
          productNames.set(d.productId, { ar: p.name_ar, en: p.name_en, active: p.active });
        } else if (!d.categoryId) {
          throw new ApiError("bad_state", "category");
        }
        dests.set(key, d);
      }
      d.items.push({ ...entry, name: withUnit(entry.name, d.unitEn), nameAr: withUnit(entry.nameAr, d.unitAr) });
    }

    // ── removals
    const removals: { ref: string; offerId: string; nameAr: string; nameEn: string; productId: string; productAr: string; productEn: string; action: "delete" | "archive" }[] = [];
    for (const ref of remove) {
      const o = offers.get(ref);
      if (!o) throw new ApiError("invalid_input", `item:${ref}`);
      if (!o.active) continue; // already not sold
      removals.push({ ref, offerId: o.id, nameAr: o.name_ar, nameEn: o.name_en, productId: o.product_id, productAr: o.product_ar, productEn: o.product_en, action: o.has_orders ? "archive" : "delete" });
    }

    // ── products left with nothing to sell
    const removedIds = removals.map((r) => r.offerId);
    const receiving = new Set([...dests.values()].map((d) => d.productId).filter((x): x is string => !!x));
    const touched = [...new Set(removals.map((r) => r.productId))].filter((p) => !receiving.has(p));
    const hide = touched.length
      ? await db.query<{ id: string; name_ar: string; name_en: string }>(
          `select p.id, p.name_ar, p.name_en from app.products p
            where p.id in (select jsonb_array_elements_text($1::text::jsonb)::uuid) and p.active
              and not exists (select 1 from app.offers o where o.product_id = p.id and o.active
                                and o.id not in (select jsonb_array_elements_text($2::text::jsonb)::uuid))`,
          [JSON.stringify(touched), JSON.stringify(removedIds)],
        )
      : [];
    const show = [...receiving].filter((p) => productNames.get(p)?.active === false);

    const plan = {
      add: [...dests.values()].map((d) => ({
        key: d.key, productId: d.productId, categoryId: d.categoryId, nameAr: d.nameAr, nameEn: d.nameEn, unitAr: d.unitAr, unitEn: d.unitEn, isNew: d.isNew,
        items: d.items.map((i) => ({
          ref: i.ref, name: i.name, nameAr: i.nameAr, warrantyEn: i.warrantyEn, warrantyAr: i.warrantyAr,
          costCents: i.costCents, priceCents: i.priceCents, reactivate: !!i.reactivate,
        })),
      })),
      remove: removals.map(({ offerId: _o, productId: _p, ...r }) => r),
      hide: hide.map((p) => ({ id: p.id, nameAr: p.name_ar, nameEn: p.name_en })),
      show: show.map((id) => ({ id, nameAr: productNames.get(id)!.ar, nameEn: productNames.get(id)!.en })),
    };
    const counts = {
      added: plan.add.reduce((s, d) => s + d.items.length, 0),
      deleted: removals.filter((r) => r.action === "delete").length,
      archived: removals.filter((r) => r.action === "archive").length,
      productsCreated: plan.add.filter((d) => d.isNew).length,
      productsHidden: hide.length,
    };
    if (dryRun) return { plan, counts, version };

    // ── apply
    for (const d of dests.values()) {
      let productId = d.productId;
      if (!productId) {
        const slug = await uniqueSlug(db, slugBase(d.nameEn, `${supplierId.replace(/_/g, "-")}-${hashOf(d.key)}`));
        const fill = (t: string, name: string) => t.replaceAll("{name}", name).slice(0, 4000);
        const rows = await db.query<{ id: string }>(
          `insert into app.products (slug, category_id, name_ar, name_en, kind, active, description_ar, description_en, search_terms, unit_ar, unit_en)
           values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10) returning id`,
          [
            slug, d.categoryId, d.nameAr, d.nameEn, d.kind, fill(sup.import_description_ar, d.nameAr), fill(sup.import_description_en, d.nameEn),
            `${d.nameEn} ${d.nameAr}`.slice(0, 500), d.unitAr, d.unitEn,
          ],
        );
        productId = rows[0]!.id;
        await audit(db, { actor: staff.id, action: "product.create", targetType: "product", targetId: productId, data: { slug, supplierId, from: d.key } });
      }
      for (const i of d.items) {
        if (i.reactivate) {
          await db.query(
            `update app.offers set active = true, cost_cents = $2::bigint, pending_cost_cents = null, cost_checked_at = now(),
                    price_cents = case when markup_mode = 'manual' then greatest(price_cents, ceil($2::bigint * (1 + min_margin_pct / 100))::bigint) else $3::bigint end,
                    paused_reason = case when paused_reason in ('supplier_unavailable', 'cost_above_margin', 'cost_jump') then null else paused_reason end
              where id = $1`,
            [i.reactivate, i.costCents, i.priceCents],
          );
        } else {
          await db.query(
            `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, markup_mode, markup_value,
                                     round_to_cents, min_margin_pct, input_fields, cost_checked_at, warranty_en, warranty_ar, success_pct)
             values ($1, $11, $2, $3, $4, $5, $6, 'percent', $7, $8, $9, $10::text::jsonb, now(), $12, $13, $14)`,
            [
              productId, i.name.slice(0, 120), supplierId, i.ref, i.costCents, i.priceCents, rule.value, rule.roundToCents, rule.minMarginPct,
              JSON.stringify(i.fields), i.nameAr.slice(0, 120), i.warrantyEn?.slice(0, 40) ?? null, i.warrantyAr?.slice(0, 40) ?? null,
              i.successPct,
            ],
          );
        }
      }
    }
    const del = removals.filter((r) => r.action === "delete").map((r) => r.offerId);
    const arch = removals.filter((r) => r.action === "archive").map((r) => r.offerId);
    if (del.length) await db.query(`delete from app.offers where id in (select jsonb_array_elements_text($1::text::jsonb)::uuid)`, [JSON.stringify(del)]);
    if (arch.length) await db.query(`update app.offers set active = false where id in (select jsonb_array_elements_text($1::text::jsonb)::uuid)`, [JSON.stringify(arch)]);
    if (hide.length) await db.query(`update app.products set active = false where id in (select jsonb_array_elements_text($1::text::jsonb)::uuid)`, [JSON.stringify(hide.map((p) => p.id))]);
    if (show.length) await db.query(`update app.products set active = true where id in (select jsonb_array_elements_text($1::text::jsonb)::uuid)`, [JSON.stringify(show)]);
    const next = version + 1;
    await db.query(`update app.suppliers set selection_version = $2 where id = $1`, [supplierId, next]);
    await audit(db, { actor: staff.id, action: "supplier.selection", targetType: "supplier", targetId: supplierId, data: { ...counts, add: add.slice(0, 100), remove: remove.slice(0, 100) } });
    return { plan, counts, version: next };
  };

  return json(dryRun ? await run(ctx.svc.db) : await ctx.svc.db.tx(run));
}
