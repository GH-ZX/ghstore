/**
 * Admin → Suppliers: each supplier's settings (on/off, price check, import
 * pricing, names), its page (balance, what it sells, what is paused and why),
 * the review of paused packages and the markup applied to what is on sale.
 * Owner only; every change is written to app.audit_log.
 */
import { minimumPrice, priceFromCost, type MarkupMode } from "@store/core";
import { resolvePrice, type OfferPricing } from "./admin-catalog";
import { bool, optInt, optNum, updateRow } from "./admin-input";
import { audit } from "./audit";
import type { Ctx } from "./context";
import { must, n } from "./db";
import { requireStaff } from "./guard";
import { ApiError, int, json, readJson, str, SUPPLIER_ID, uuid } from "./http";
import { renameSavedItems } from "./names";

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
  const every = optInt(body, "syncMinutes", 5, 1440);
  if (every !== undefined) changes.sync_minutes = every;
  // Telegram alerts when packages run out of stock and come back.
  const stockAlerts = bool(body, "stockAlerts");
  if (stockAlerts !== undefined) changes.stock_alerts = stockAlerts;
  // Name this supplier's items with the name cleaner (Admin → Suppliers → Names).
  const cleanNames = bool(body, "cleanNames");
  if (cleanNames !== undefined) changes.clean_names = cleanNames;
  const auto = bool(body, "autoReprice");
  if (auto !== undefined) changes.auto_reprice = auto;
  if (body.maxJumpPct !== undefined) changes.max_jump_pct = body.maxJumpPct === null ? null : int(body, "maxJumpPct", 5, 1000);
  const markup = optNum(body, "importMarkupPct", 0, 1000);
  if (markup !== undefined) changes.import_markup_pct = markup;
  const margin = optNum(body, "importMinMarginPct", 0, 500);
  if (margin !== undefined) changes.import_min_margin_pct = margin;
  const round = optInt(body, "importRoundToCents", 1, 10_000);
  if (round !== undefined) changes.import_round_to_cents = round;
  // New products made from this supplier's items: their category and description ({name} = the product).
  if (body.importCategoryId !== undefined) changes.import_category_id = body.importCategoryId === null ? null : uuid(body.importCategoryId as string, "importCategoryId");
  for (const [key, col] of [["importDescriptionAr", "import_description_ar"], ["importDescriptionEn", "import_description_en"]] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > 4000) throw new ApiError("invalid_input", key);
    changes[col] = v.trim();
  }
  await updateRow(ctx, "suppliers", id, changes);
  // The saved list (Choose packages) follows at once; the store's products keep their names.
  const renamed = cleanNames !== undefined ? await renameSavedItems(ctx.svc, id) : 0;
  await audit(ctx.svc.db, { actor: staff.id, action: "supplier.update", targetType: "supplier", targetId: id, data: changes });
  return json({ ok: true, renamed });
}

/**
 * Admin → Suppliers: each supplier with its settings, balance, what it sells,
 * what is paused and why, and what the last price check did.
 */
export async function listSuppliers(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const rows = await ctx.svc.db.query<Record<string, unknown>>(
    `select s.id, s.name, s.enabled, case when 'down' in (s.health, s.sync_health) then 'down' when 'degraded' in (s.health, s.sync_health) then 'degraded' when 'ok' in (s.health, s.sync_health) then 'ok' else 'unknown' end as health, coalesce(s.last_error, s.sync_error) as last_error, s.balance_cents, s.balance_checked_at, s.low_balance_cents,
            s.last_sync_at, s.sync_minutes, s.stock_alerts,
            s.last_sync_at + make_interval(mins => s.sync_minutes) as next_sync_at, s.auto_reprice, s.max_jump_pct, s.import_markup_pct, s.import_min_margin_pct,
            s.import_round_to_cents, s.import_category_id, s.import_description_ar, s.import_description_en, s.last_sync_report,
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
  const categories = await ctx.svc.db.query(`select id, name_ar, name_en from app.categories order by sort, slug`);
  return json({
    categories,
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
      stockAlerts: r.stock_alerts === true,
      nextSyncAt: r.next_sync_at ?? null,
      autoReprice: r.auto_reprice,
      maxJumpPct: r.max_jump_pct === null ? null : Number(r.max_jump_pct),
      importMarkupPct: Number(r.import_markup_pct),
      importMinMarginPct: Number(r.import_min_margin_pct),
      importRoundToCents: Number(r.import_round_to_cents),
      importCategoryId: r.import_category_id ?? null,
      importDescriptionAr: r.import_description_ar ?? "",
      importDescriptionEn: r.import_description_en ?? "",
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
  await audit(ctx.svc.db, { actor: staff.id, action: "offer.accept_cost", targetType: "offer", targetId: id, data: { cost, price, selling: marginOk } });
  return json({ ok: true, priceCents: price, selling: marginOk });
}

/**
 * POST /api/admin/suppliers/:id/pricing { markupPct, minMarginPct, roundToCents, apply? }
 *
 * The supplier's markup for the packages already on sale, not only new imports.
 * Without `apply`: a preview (how many prices change, a few examples). With it:
 * every package of the supplier priced by a markup is repriced with these
 * numbers (and keeps them for later cost changes), and they become the
 * supplier's defaults for new imports. Packages with a price typed by hand, or
 * waiting for review after a cost jump, are left alone. Prices never go below
 * the minimum margin (priceFromCost).
 */
export async function applySupplierPricing(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const id = ctx.params.id ?? "";
  if (!SUPPLIER_ID.test(id)) throw new ApiError("not_found");
  const body = await readJson(ctx.req);
  const markup = optNum(body, "markupPct", 0, 1000);
  const minMargin = optNum(body, "minMarginPct", 0, 500);
  const round = optInt(body, "roundToCents", 1, 10_000);
  if (markup === undefined) throw new ApiError("invalid_input", "markupPct");
  if (minMargin === undefined) throw new ApiError("invalid_input", "minMarginPct");
  if (round === undefined) throw new ApiError("invalid_input", "roundToCents");
  const apply = bool(body, "apply") === true;
  await must(ctx.svc.db, `select id from app.suppliers where id = $1`, [id], "not_found");

  const offers = await ctx.svc.db.query<{
    id: string; cost_cents: string | number | null; price_cents: string | number; markup_mode: MarkupMode; paused_reason: string | null;
    name_ar: string; name_en: string; product_ar: string; product_en: string;
  }>(
    `select o.id, o.cost_cents, o.price_cents, o.markup_mode, o.paused_reason, o.name_ar, o.name_en, p.name_ar as product_ar, p.name_en as product_en
       from app.offers o join app.products p on p.id = o.product_id
      where o.supplier_id = $1`,
    [id],
  );
  const rule = { mode: "percent" as const, value: markup, roundToCents: round, minMarginPct: minMargin };
  const repriced: { id: string; cost: number; old: number; price: number }[] = [];
  const examples: { productAr: string; productEn: string; nameAr: string; nameEn: string; oldCents: number; newCents: number }[] = [];
  let unchanged = 0;
  let skippedManual = 0;
  let skippedReview = 0;
  for (const o of offers) {
    if (o.markup_mode === "manual") { skippedManual++; continue; }
    if (o.paused_reason === "cost_jump" || o.cost_cents === null) { skippedReview++; continue; }
    const cost = n(o.cost_cents);
    const old = n(o.price_cents);
    const price = priceFromCost(cost, rule);
    repriced.push({ id: o.id, cost, old, price });
    if (price === old) { unchanged++; continue; }
    examples.push({ productAr: o.product_ar, productEn: o.product_en, nameAr: o.name_ar, nameEn: o.name_en, oldCents: old, newCents: price });
  }
  const changed = repriced.length - unchanged;
  // The biggest moves first, so the preview shows what matters.
  examples.sort((a, b) => Math.abs(b.newCents - b.oldCents) - Math.abs(a.newCents - a.oldCents));
  const summary = { changed, unchanged, skippedManual, skippedReview, total: offers.length };
  if (!apply) return json({ ...summary, examples: examples.slice(0, 6) });

  if (repriced.length) {
    await ctx.svc.db.query(
      `update app.offers o set markup_mode = 'percent', markup_value = $2, round_to_cents = $3, min_margin_pct = $4, price_cents = x.price
         from jsonb_to_recordset($1::text::jsonb) as x(id uuid, price bigint)
        where o.id = x.id`,
      [JSON.stringify(repriced.map((r) => ({ id: r.id, price: r.price }))), markup, round, minMargin],
    );
    const moved = repriced.filter((r) => r.price !== r.old);
    if (moved.length) {
      await ctx.svc.db.query(
        `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action)
         select x.id, x.cost, x.cost, x.old, x.price, 'manual' from jsonb_to_recordset($1::text::jsonb) as x(id uuid, cost bigint, old bigint, price bigint)`,
        [JSON.stringify(moved)],
      );
    }
  }
  await ctx.svc.db.query(
    `update app.suppliers set import_markup_pct = $2, import_min_margin_pct = $3, import_round_to_cents = $4 where id = $1`,
    [id, markup, minMargin, round],
  );
  await audit(ctx.svc.db, { actor: staff.id, action: "supplier.pricing", targetType: "supplier", targetId: id, data: { markup, minMargin, round, ...summary } });
  return json(summary);
}
