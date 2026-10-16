/**
 * Admin → Suppliers → Names: how items of suppliers that write shorthand
 * (BatStore, ProdSeller; app.suppliers.clean_names) are named in Choose
 * packages and in new products (core/names.ts).
 *
 * GET  /api/admin/names?supplier=   the word list, the suppliers, and one
 *                                    supplier's saved items with their clean names
 * POST /api/admin/names/preview     { supplierId, words } the same items named
 *                                    with an unsaved list (nothing is written)
 * PUT  /api/admin/names             { words } save the list and rename every
 *                                    saved item of those suppliers
 *
 * Renaming touches the saved supplier lists only, never the store: products
 * already on sale keep the names they have.
 */
import { cleanSupplierName, DEFAULT_NAME_WORDS, parseNameWords, type CleanName, type NameWord } from "@store/core";
import { requireStaff } from "./auth";
import type { Ctx, Services } from "./context";
import { ApiError, json, readJson } from "./http";
import { checkSupplierId } from "./supplier-catalogue";

const SETTING = "catalog.name_words";
/** Items shown in the preview, at most. */
const PREVIEW_MAX = 400;

/** The owner's word list, or the built-in one. */
export async function nameWords(svc: Pick<Services, "db">): Promise<{ words: NameWord[]; isDefault: boolean }> {
  const rows = await svc.db.query<{ value: unknown }>(`select value from app.settings where key = $1`, [SETTING]);
  const saved = rows[0] ? parseNameWords(rows[0].value) : null;
  return saved ? { words: saved, isDefault: false } : { words: DEFAULT_NAME_WORDS, isDefault: true };
}

/** A namer for this supplier's items, or null when its own names are kept. */
export async function namerFor(svc: Pick<Services, "db">, supplierId: string): Promise<((name: string) => CleanName) | null> {
  const s = await svc.db.query<{ clean_names: boolean }>(`select clean_names from app.suppliers where id = $1`, [supplierId]);
  if (!s[0]?.clean_names) return null;
  const { words } = await nameWords(svc);
  return (name) => cleanSupplierName(name, words);
}

/** The columns a clean name fills on app.supplier_items. */
export function cleanColumns(c: CleanName) {
  return {
    product_key: `n:${c.key}`.slice(0, 160),
    product_name: c.productEn,
    product_name_ar: c.productAr,
    package_name: c.packageEn,
    package_name_ar: c.packageAr,
    warranty_en: c.warrantyEn,
    warranty_ar: c.warrantyAr,
  };
}

/**
 * Name (or un-name) every saved item of a supplier again, in one write. No
 * supplier request: the names come from the saved copy. Answers how many changed.
 */
export async function renameSavedItems(svc: Pick<Services, "db">, supplierId: string): Promise<number> {
  const namer = await namerFor(svc, supplierId);
  const items = await svc.db.query<{ external_id: string; name: string }>(`select external_id, name from app.supplier_items where supplier_id = $1`, [supplierId]);
  if (!items.length) return 0;
  const rows = items.map((i) => ({
    external_id: i.external_id,
    ...(namer
      ? cleanColumns(namer(i.name))
      : { product_key: null, product_name: null, product_name_ar: null, package_name: null, package_name_ar: null, warranty_en: null, warranty_ar: null }),
  }));
  const changed = await svc.db.query(
    `update app.supplier_items i
        set product_key = x.product_key, product_name = x.product_name, product_name_ar = x.product_name_ar,
            package_name = x.package_name, package_name_ar = x.package_name_ar, warranty_en = x.warranty_en, warranty_ar = x.warranty_ar
       from jsonb_to_recordset($2::text::jsonb) as x(external_id text, product_key text, product_name text, product_name_ar text,
                                                    package_name text, package_name_ar text, warranty_en text, warranty_ar text)
      where i.supplier_id = $1 and i.external_id = x.external_id
        and (i.product_key, i.product_name, i.product_name_ar, i.package_name, i.package_name_ar, i.warranty_en, i.warranty_ar)
            is distinct from (x.product_key, x.product_name, x.product_name_ar, x.package_name, x.package_name_ar, x.warranty_en, x.warranty_ar)
      returning 1`,
    [supplierId, JSON.stringify(rows)],
  );
  return changed.length;
}

/** Scheduled (and after deploys): suppliers switched to clean names whose saved items are not named yet. */
export async function nameUnnamedItems(svc: Pick<Services, "db">): Promise<number> {
  const due = await svc.db.query<{ id: string }>(
    `select s.id from app.suppliers s
      where s.clean_names and exists (select 1 from app.supplier_items i where i.supplier_id = s.id and i.product_key is null)`,
  );
  let n = 0;
  for (const s of due) n += await renameSavedItems(svc, s.id);
  return n;
}

async function previewItems(svc: Services, supplierId: string, words: NameWord[]) {
  const items = await svc.db.query<{ external_id: string; name: string; cost_cents: string | number; available: boolean }>(
    `select external_id, name, cost_cents, available from app.supplier_items
      where supplier_id = $1 and missing_since is null order by available desc, name limit $2`,
    [supplierId, PREVIEW_MAX],
  );
  return items.map((i) => {
    const c = cleanSupplierName(i.name, words);
    return {
      ref: i.external_id, name: i.name, available: i.available, costCents: Number(i.cost_cents),
      productEn: c.productEn, productAr: c.productAr, packageEn: c.packageEn, packageAr: c.packageAr,
      warrantyEn: c.warrantyEn, warrantyAr: c.warrantyAr,
    };
  });
}

export async function getNames(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const suppliers = await ctx.svc.db.query<{ id: string; name: string; clean_names: boolean; items: string | number }>(
    `select s.id, s.name, s.clean_names, (select count(*) from app.supplier_items i where i.supplier_id = s.id and i.missing_since is null) as items
       from app.suppliers s order by s.clean_names desc, s.name`,
  );
  const wanted = ctx.url.searchParams.get("supplier");
  const pick = wanted ? checkSupplierId(wanted) : suppliers.find((s) => s.clean_names && Number(s.items) > 0)?.id ?? suppliers.find((s) => s.clean_names)?.id;
  const { words, isDefault } = await nameWords(ctx.svc);
  return json({
    words,
    isDefault,
    defaults: DEFAULT_NAME_WORDS,
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, cleanNames: s.clean_names, items: Number(s.items) })),
    supplierId: pick ?? null,
    items: pick ? await previewItems(ctx.svc, pick, words) : [],
  });
}

export async function previewNames(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req, 65_536);
  const supplierId = checkSupplierId(typeof body.supplierId === "string" ? body.supplierId : undefined);
  const words = parseNameWords(body.words);
  if (!words) throw new ApiError("invalid_input", "words");
  return json({ items: await previewItems(ctx.svc, supplierId, words) });
}

export async function putNames(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const body = await readJson(ctx.req, 65_536);
  const words = body.words === null ? null : parseNameWords(body.words);
  if (body.words !== null && !words) throw new ApiError("invalid_input", "words");
  if (words) {
    await ctx.svc.db.query(
      `insert into app.settings (key, value, updated_by, updated_at) values ($1, $2::text::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [SETTING, JSON.stringify(words), staff.id],
    );
  } else {
    // Back to the built-in list.
    await ctx.svc.db.query(`delete from app.settings where key = $1`, [SETTING]);
  }
  const suppliers = await ctx.svc.db.query<{ id: string }>(`select id from app.suppliers where clean_names`);
  let renamed = 0;
  for (const s of suppliers) renamed += await renameSavedItems(ctx.svc, s.id);
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, 'names.update', 'setting', $2, $3::text::jsonb)`,
    [staff.id, SETTING, JSON.stringify({ words: words?.length ?? "default", renamed })],
  );
  return json({ ok: true, renamed });
}
