/**
 * A saved copy of what each supplier offers (app.supplier_groups / app.supplier_items),
 * for Admin → Suppliers → Choose packages.
 *
 * The copy is filled a group at a time: a group of a big catalogue (a G2Bulk
 * game), or, for a supplier that lists everything at once, the whole list
 * (group id ""). It is refreshed when the owner opens a group whose copy is old,
 * on "Refresh list", and by a scheduled job with the requests a run has left
 * (CLAUDE.md: 50 per run on the free plan). The price check also writes the
 * costs it reads. A failed read never marks anything as gone.
 *
 * How items become store products is each supplier's own business: the adapter
 * says which items belong together (productKey); BatStore and ProdSeller items
 * are products of their own.
 */
import type { SupplierAdapter, SupplierProduct } from "@store/core";
import { requireStaff } from "./auth";
import type { Ctx, Services } from "./context";
import { n } from "./db";
import { ApiError, json, readJson } from "./http";
import { room } from "./jobs";

const SUPPLIER_ID = /^[a-z0-9_]{2,32}$/;
const GROUP_ID = /^[\p{L}\p{N}:_.\- ]{0,120}$/u;
const KINDS = new Set(["id", "code", "account", "link", "sms"]);
/** One refresh stores at most this many items (5SIM lists every country × service). */
export const MAX_ITEMS = 5000;
/** A group's copy older than this is read again when the owner opens it. */
const ITEMS_MAX_AGE_H = 24;
/** "New" items: first seen after the group's first read, within this many days. */
const NEW_DAYS = 14;

export function checkSupplierId(id: string | undefined): string {
  if (!id || !SUPPLIER_ID.test(id)) throw new ApiError("not_found");
  return id;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Read the supplier's list of groups (a big catalogue) and save it. */
export async function refreshGroups(svc: Services, supplierId: string): Promise<number> {
  const adapter = svc.supplier(supplierId);
  if (!adapter?.listGroups) return 0;
  const groups = await adapter.listGroups();
  const seen = new Map<string, { id: string; name: string; image_url: string | null; sort: number }>();
  groups.forEach((g, i) => {
    const id = String(g.id).slice(0, 120);
    if (id && GROUP_ID.test(id) && !seen.has(id)) seen.set(id, { id, name: String(g.name || id).slice(0, 200), image_url: g.image?.startsWith("https://") ? g.image.slice(0, 500) : null, sort: i });
  });
  const rows = [...seen.values()];
  // An empty answer is far more likely a supplier glitch than a closed shop.
  if (rows.length === 0) throw new Error("the supplier listed no groups");
  await svc.db.query(
    `insert into app.supplier_groups (supplier_id, id, name, image_url, sort)
     select $1, x.id, x.name, x.image_url, x.sort from jsonb_to_recordset($2::text::jsonb) as x(id text, name text, image_url text, sort int)
     on conflict (supplier_id, id) do update set name = excluded.name, image_url = excluded.image_url, sort = excluded.sort, missing_since = null`,
    [supplierId, JSON.stringify(rows)],
  );
  await svc.db.query(
    `update app.supplier_groups set missing_since = now()
      where supplier_id = $1 and missing_since is null and id <> ''
        and id not in (select jsonb_array_elements_text($2::text::jsonb))`,
    [supplierId, JSON.stringify(rows.map((r) => r.id))],
  );
  await svc.db.query(`update app.suppliers set groups_at = now() where id = $1`, [supplierId]);
  return rows.length;
}

function itemRow(p: SupplierProduct) {
  const cut = (v: string | undefined, max: number) => (v ? v.slice(0, max) : null);
  return {
    external_id: p.externalId,
    name: p.name.slice(0, 300) || p.externalId,
    product_key: cut(p.productKey, 160),
    product_name: cut(p.productName, 200),
    product_name_ar: cut(p.productNameAr, 200),
    package_name: cut(p.packageName, 300),
    package_name_ar: cut(p.packageNameAr, 300),
    cost_cents: p.costCents,
    available: p.available,
    kind: KINDS.has(p.kind) ? p.kind : "code",
    fields: Array.isArray(p.fields) ? p.fields.slice(0, 6) : [],
  };
}

/**
 * Read one group's items from the supplier and save them ("" = a supplier's
 * whole list). Items it no longer lists in that group are marked as gone.
 */
export async function refreshItems(svc: Services, supplierId: string, groupId: string): Promise<number> {
  const adapter = svc.supplier(supplierId);
  if (!adapter) throw new ApiError("bad_state");
  if (!GROUP_ID.test(groupId) || (groupId === "") !== !adapter.listGroups) throw new ApiError("invalid_input", "group");
  await svc.db.query(
    `insert into app.supplier_groups (supplier_id, id, name) values ($1, $2, $2) on conflict (supplier_id, id) do nothing`,
    [supplierId, groupId],
  );
  let products: SupplierProduct[];
  try {
    products = await adapter.listProducts(groupId || undefined);
  } catch (err) {
    await svc.db.query(`update app.supplier_groups set items_error = $3 where supplier_id = $1 and id = $2`, [supplierId, groupId, errText(err)]);
    throw err;
  }
  const byRef = new Map<string, ReturnType<typeof itemRow>>();
  for (const p of products) {
    if (byRef.size >= MAX_ITEMS) break;
    if (typeof p.externalId === "string" && p.externalId && p.externalId.length <= 120 && Number.isSafeInteger(p.costCents) && p.costCents >= 0 && !byRef.has(p.externalId)) {
      byRef.set(p.externalId, itemRow(p));
    }
  }
  const rows = [...byRef.values()];
  if (rows.length === 0 && groupId === "") {
    // A supplier's whole list coming back empty is a glitch, not a closed shop.
    const had = await svc.db.query(`select 1 from app.supplier_items where supplier_id = $1 and missing_since is null limit 1`, [supplierId]);
    if (had.length) {
      const msg = "the supplier listed nothing";
      await svc.db.query(`update app.supplier_groups set items_error = $3 where supplier_id = $1 and id = $2`, [supplierId, groupId, msg]);
      throw new Error(msg);
    }
  }
  if (rows.length) {
    await svc.db.query(
      `insert into app.supplier_items (supplier_id, external_id, group_id, name, product_key, product_name, product_name_ar, package_name, package_name_ar,
                                       cost_cents, available, kind, fields)
       select $1, x.external_id, $2, x.name, x.product_key, x.product_name, x.product_name_ar, x.package_name, x.package_name_ar,
              x.cost_cents, x.available, x.kind, coalesce(x.fields, '[]'::jsonb)
         from jsonb_to_recordset($3::text::jsonb)
           as x(external_id text, name text, product_key text, product_name text, product_name_ar text, package_name text, package_name_ar text,
                cost_cents bigint, available boolean, kind text, fields jsonb)
       on conflict (supplier_id, external_id) do update
         set group_id = excluded.group_id, name = excluded.name, product_key = excluded.product_key, product_name = excluded.product_name,
             product_name_ar = excluded.product_name_ar, package_name = excluded.package_name, package_name_ar = excluded.package_name_ar,
             cost_cents = excluded.cost_cents, available = excluded.available, kind = excluded.kind,
             fields = excluded.fields, last_seen_at = now(), missing_since = null`,
      [supplierId, groupId, JSON.stringify(rows)],
    );
  }
  await svc.db.query(
    `update app.supplier_items set missing_since = now()
      where supplier_id = $1 and group_id = $2 and missing_since is null
        and external_id not in (select jsonb_array_elements_text($3::text::jsonb))`,
    [supplierId, groupId, JSON.stringify(rows.map((r) => r.external_id))],
  );
  await svc.db.query(
    `update app.supplier_groups set items_at = now(), first_items_at = coalesce(first_items_at, now()), items_error = null
      where supplier_id = $1 and id = $2`,
    [supplierId, groupId],
  );
  return rows.length;
}

/** The price check read these costs anyway: keep the saved copy in step, for free. */
export async function noteSupplierPrices(svc: Services, supplierId: string, products: SupplierProduct[]): Promise<void> {
  if (!products.length) return;
  const rows = products.slice(0, MAX_ITEMS).filter((p) => Number.isSafeInteger(p.costCents) && p.costCents >= 0)
    .map((p) => ({ external_id: p.externalId, cost_cents: p.costCents, available: p.available }));
  await svc.db.query(
    `update app.supplier_items i set cost_cents = x.cost_cents, available = x.available, last_seen_at = now(), missing_since = null
       from jsonb_to_recordset($2::text::jsonb) as x(external_id text, cost_cents bigint, available boolean)
      where i.supplier_id = $1 and i.external_id = x.external_id
        and (i.cost_cents <> x.cost_cents or i.available <> x.available or i.missing_since is not null)`,
    [supplierId, JSON.stringify(rows)],
  );
}

/**
 * Scheduled: keep every enabled supplier's saved copy fresh, a few groups per
 * run and only while the run has requests to spare (a G2Bulk game takes ~4).
 */
export async function refreshDueCatalogues(svc: Services, opts: { maxGroups?: number; reserve?: number } = {}): Promise<number> {
  let left = opts.maxGroups ?? 3;
  const reserve = opts.reserve ?? 8;
  const suppliers = await svc.db.query<{ id: string; groups_due: boolean }>(
    `select id, (groups_at is null or groups_at < now() - interval '24 hours') as groups_due from app.suppliers where enabled order by id`,
  );
  let done = 0;
  for (const s of suppliers) {
    const adapter = svc.supplier(s.id);
    if (!adapter) continue;
    if (left <= 0 || room(svc) < reserve) break;
    try {
      if (adapter.listGroups && s.groups_due) {
        await refreshGroups(svc, s.id);
        left--;
      }
      const due = await svc.db.query<{ id: string }>(
        adapter.listGroups
          ? `select id from app.supplier_groups
              where supplier_id = $1 and id <> '' and missing_since is null
                and (items_at is null or items_at < now() - make_interval(hours => $3))
              order by items_at nulls first, sort limit $2`
          : `select '' as id where not exists (select 1 from app.supplier_groups
              where supplier_id = $1 and id = '' and items_at > now() - make_interval(hours => $3 / 4)) and $2 > 0`,
        [s.id, left, ITEMS_MAX_AGE_H],
      );
      for (const g of due) {
        if (left <= 0 || room(svc) < reserve) break;
        left--;
        try {
          await refreshItems(svc, s.id, g.id);
          done++;
        } catch (err) {
          console.error(`catalogue ${s.id}/${g.id}:`, errText(err));
        }
      }
    } catch (err) {
      console.error(`catalogue ${s.id}:`, errText(err));
    }
  }
  return done;
}

// ─────────────────────────────────────────────────────────────── admin screen

interface SupplierRow {
  id: string;
  name: string;
  enabled: boolean;
  groups_at: string | null;
  selection_version: number;
  import_markup_pct: string | number;
  import_min_margin_pct: string | number;
  import_round_to_cents: number;
  import_category_id: string | null;
}

async function supplierRow(svc: Services, id: string): Promise<SupplierRow> {
  const rows = await svc.db.query<SupplierRow>(
    `select id, name, enabled, groups_at, selection_version, import_markup_pct, import_min_margin_pct, import_round_to_cents, import_category_id
       from app.suppliers where id = $1`,
    [id],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

/** Which browse group a package belongs to when its item is not in the saved copy. */
function groupOfRef(adapter: SupplierAdapter, ref: string): string {
  return adapter.listGroups && adapter.syncGroup ? adapter.syncGroup(ref) : "";
}

/**
 * GET /api/admin/suppliers/:id/catalogue — the screen's frame: the supplier's
 * groups with "chosen / total" counts, its import defaults, the store's
 * categories and products (where new packages can go) and the version to send
 * back. A big catalogue lists its groups (G2Bulk's games); a supplier that
 * lists everything at once is grouped by its own product suggestion.
 */
export async function getCatalogue(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const id = checkSupplierId(ctx.params.id);
  const svc = ctx.svc;
  let sup = await supplierRow(svc, id);
  const adapter = svc.supplier(id);
  if (!adapter) throw new ApiError("bad_state", "supplier");
  const grouped = !!adapter.listGroups;
  let error: string | null = null;

  // First visit: read the list now (one or two requests).
  try {
    if (grouped && !sup.groups_at) {
      await refreshGroups(svc, id);
      sup = await supplierRow(svc, id);
    } else if (!grouped) {
      const g = await svc.db.query(`select 1 from app.supplier_groups where supplier_id = $1 and id = '' and items_at is not null`, [id]);
      if (!g.length) await refreshItems(svc, id, "");
    }
  } catch (err) {
    error = errText(err);
  }

  // Counts per browse group, from the saved copy and the store's packages.
  const key = grouped ? "i.group_id" : "coalesce(i.product_key, '')";
  const counts = await svc.db.query<{ id: string; name: string | null; total: string | number; chosen: string | number; fresh: string | number; gone: string | number }>(
    `select ${key} as id, max(coalesce(i.product_name, '')) as name,
            count(*) filter (where i.missing_since is null) as total,
            count(o.id) filter (where o.active) as chosen,
            count(*) filter (where i.missing_since is null and i.available and (o.id is null or not o.active)
                               and i.first_seen_at > g.first_items_at + interval '1 minute'
                               and i.first_seen_at > now() - make_interval(days => $2)) as fresh,
            count(o.id) filter (where o.active and (i.missing_since is not null or not i.available)) as gone
       from app.supplier_items i
       join app.supplier_groups g on g.supplier_id = i.supplier_id and g.id = i.group_id
       left join app.offers o on o.supplier_id = i.supplier_id and o.supplier_ref = i.external_id
      where i.supplier_id = $1
      group by 1`,
    [id, NEW_DAYS],
  );
  const byId = new Map(counts.map((c) => [c.id, { name: c.name ?? "", total: n(c.total), chosen: n(c.chosen), fresh: n(c.fresh), gone: n(c.gone) }]));

  const groupRows = grouped
    ? await svc.db.query<{ id: string; name: string; image_url: string | null; items_at: string | null; items_error: string | null; missing: boolean }>(
        `select id, name, image_url, items_at, items_error, missing_since is not null as missing
           from app.supplier_groups where supplier_id = $1 and id <> '' order by sort, name`,
        [id],
      )
    : [];
  const itemsAtFlat = grouped
    ? null
    : (await svc.db.query<{ items_at: string | null }>(`select items_at from app.supplier_groups where supplier_id = $1 and id = ''`, [id]))[0]?.items_at ?? null;

  // Packages whose item is not in the copy (never read yet, or gone for good).
  const orphans = await svc.db.query<{ supplier_ref: string }>(
    `select o.supplier_ref from app.offers o
      where o.supplier_id = $1 and o.active
        and not exists (select 1 from app.supplier_items i where i.supplier_id = o.supplier_id and i.external_id = o.supplier_ref)`,
    [id],
  );
  const readGroups = new Set(groupRows.filter((g) => g.items_at).map((g) => g.id));
  for (const o of orphans) {
    const gid = groupOfRef(adapter, o.supplier_ref);
    const c = byId.get(gid) ?? { name: "", total: 0, chosen: 0, fresh: 0, gone: 0 };
    c.chosen++;
    if (!grouped || readGroups.has(gid)) c.gone++;
    byId.set(gid, c);
  }

  const groups = grouped
    ? groupRows
        .filter((g) => !g.missing || (byId.get(g.id)?.chosen ?? 0) > 0)
        .map((g) => {
          const c = byId.get(g.id);
          return {
            id: g.id, name: g.name, image: g.image_url, itemsAt: g.items_at, error: g.items_error, missing: g.missing,
            total: g.items_at ? c?.total ?? 0 : null, chosen: c?.chosen ?? 0, fresh: c?.fresh ?? 0, gone: c?.gone ?? 0,
          };
        })
    : [...byId.entries()].map(([gid, c]) => ({
        id: gid, name: gid ? c.name || gid : "", image: null, itemsAt: itemsAtFlat, error: null, missing: false,
        total: c.total, chosen: c.chosen, fresh: c.fresh, gone: c.gone,
      }));

  const suppliers = await svc.db.query<{ id: string; name: string; enabled: boolean }>(`select id, name, enabled from app.suppliers order by enabled desc, name`);
  const categories = await svc.db.query(`select id, slug, name_ar, name_en from app.categories order by sort, slug`);
  const products = await svc.db.query(`select id, category_id, name_ar, name_en, active from app.products order by name_en`);
  return json({
    supplier: {
      id: sup.id,
      name: sup.name,
      enabled: sup.enabled,
      grouped,
      listedAt: grouped ? sup.groups_at : itemsAtFlat,
      markupPct: Number(sup.import_markup_pct),
      minMarginPct: Number(sup.import_min_margin_pct),
      roundToCents: Number(sup.import_round_to_cents),
      categoryId: sup.import_category_id,
    },
    version: sup.selection_version,
    error,
    groups,
    suppliers: suppliers.filter((s) => svc.supplier(s.id)),
    categories,
    products,
  });
}

/**
 * GET /api/admin/suppliers/:id/catalogue/items?group= — one group's items, each
 * with the package that sells it (if any). Opening a group of a big catalogue
 * whose copy is missing or old reads it from the supplier first.
 */
export async function getCatalogueItems(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const id = checkSupplierId(ctx.params.id);
  const svc = ctx.svc;
  await supplierRow(svc, id);
  const adapter = svc.supplier(id);
  if (!adapter) throw new ApiError("bad_state", "supplier");
  const grouped = !!adapter.listGroups;
  const group = ctx.url.searchParams.get("group") ?? "";
  if (!GROUP_ID.test(group) || (grouped && !group)) throw new ApiError("invalid_input", "group");

  let error: string | null = null;
  if (grouped) {
    const g = await svc.db.query<{ fresh: boolean }>(
      `select items_at > now() - make_interval(hours => $3) as fresh from app.supplier_groups where supplier_id = $1 and id = $2`,
      [id, group, ITEMS_MAX_AGE_H],
    );
    if (!g[0]?.fresh) {
      try {
        await refreshItems(svc, id, group);
      } catch (err) {
        error = errText(err);
      }
    }
  }

  const where = grouped ? "i.group_id = $2" : "i.group_id = '' and coalesce(i.product_key, '') = $2";
  const rows = await svc.db.query<Record<string, unknown>>(
    `select i.external_id, i.name, i.product_key, i.product_name, i.package_name, i.package_name_ar, i.cost_cents, i.available, i.kind,
            i.missing_since is not null as missing,
            (i.first_seen_at > g.first_items_at + interval '1 minute' and i.first_seen_at > now() - make_interval(days => $3)) as fresh,
            o.id as offer_id, o.active, o.price_cents, o.cost_cents as offer_cost_cents, o.paused_reason, o.product_id,
            p.name_ar as product_ar, p.name_en as product_en
       from app.supplier_items i
       join app.supplier_groups g on g.supplier_id = i.supplier_id and g.id = i.group_id
       left join app.offers o on o.supplier_id = i.supplier_id and o.supplier_ref = i.external_id
       left join app.products p on p.id = o.product_id
      where i.supplier_id = $1 and ${where} and (i.missing_since is null or o.active)
      order by i.product_name nulls last, i.cost_cents, i.name`,
    [id, group, NEW_DAYS],
  );
  // Packages of this group whose item the supplier no longer lists at all.
  const orphans = (
    await svc.db.query<Record<string, unknown>>(
      `select o.id as offer_id, o.supplier_ref as external_id, o.name_en as name, o.active, o.price_cents, o.cost_cents as offer_cost_cents,
              o.paused_reason, o.product_id, p.name_ar as product_ar, p.name_en as product_en, p.kind
         from app.offers o join app.products p on p.id = o.product_id
        where o.supplier_id = $1 and o.active
          and not exists (select 1 from app.supplier_items i where i.supplier_id = o.supplier_id and i.external_id = o.supplier_ref)`,
      [id],
    )
  ).filter((o) => groupOfRef(adapter, String(o.external_id)) === (grouped ? group : ""));
  const groupRead = grouped
    ? (await svc.db.query<{ items_at: string | null }>(`select items_at from app.supplier_groups where supplier_id = $1 and id = $2`, [id, group]))[0]?.items_at ?? null
    : (await svc.db.query<{ items_at: string | null }>(`select items_at from app.supplier_groups where supplier_id = $1 and id = ''`, [id]))[0]?.items_at ?? null;

  const num = (v: unknown) => (v === null || v === undefined ? null : n(v));
  const offerOf = (r: Record<string, unknown>) =>
    r.offer_id
      ? {
          id: r.offer_id,
          active: r.active,
          priceCents: num(r.price_cents),
          costCents: num(r.offer_cost_cents),
          pausedReason: r.paused_reason,
          productId: r.product_id,
          productAr: r.product_ar,
          productEn: r.product_en,
        }
      : null;
  return json({
    group,
    itemsAt: groupRead,
    error,
    items: [
      ...rows.map((r) => ({
        ref: r.external_id,
        name: r.name,
        packageName: r.package_name,
        packageNameAr: r.package_name_ar,
        productKey: r.product_key,
        productName: r.product_name,
        costCents: n(r.cost_cents),
        available: r.available,
        kind: r.kind,
        missing: r.missing,
        fresh: r.fresh === true && !(r.offer_id && r.active),
        offer: offerOf(r),
      })),
      ...(groupRead
        ? orphans.map((r) => ({
            ref: r.external_id, name: r.name, packageName: null, productKey: null, productName: null, costCents: num(r.offer_cost_cents) ?? 0,
            available: false, kind: r.kind, missing: true, fresh: false, offer: offerOf(r),
          }))
        : []),
    ],
  });
}

/** POST /api/admin/suppliers/:id/catalogue/refresh — "Refresh list": the groups, or one group's items. */
export async function refreshCatalogue(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const id = checkSupplierId(ctx.params.id);
  await supplierRow(ctx.svc, id);
  const adapter = ctx.svc.supplier(id);
  if (!adapter) throw new ApiError("bad_state", "supplier");
  const body = await readJson(ctx.req);
  const group = typeof body.group === "string" ? body.group : null;
  try {
    if (adapter.listGroups && group === null) return json({ ok: true, groups: await refreshGroups(ctx.svc, id) });
    return json({ ok: true, items: await refreshItems(ctx.svc, id, adapter.listGroups ? group ?? "" : "") });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return json({ ok: false, error: errText(err) });
  }
}
