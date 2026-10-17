/**
 * Catalogue editor: products, their packages (offers) and manual stock. What
 * to sell from a supplier is chosen in Suppliers → Choose packages (Choose.tsx).
 * Prices preview with the same rule the server enforces.
 */
import { useMemo, useState } from "react";
import { matchesQuery, minimumPrice, priceFromCost, type MarkupMode } from "@store/core";
import { linkHandler } from "../lib/router";
import { dollarsToCents, usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { toast, useT } from "../lib/state";
import { invalidate, useApi } from "../lib/useApi";
import type { AfterFieldDef, AfterType, InputField, Kind, ProductBadge } from "../lib/types";
import { PlusIcon } from "../ui/icons";
import { Empty, ErrorBox, Sheet, Spinner, Switch } from "../ui/kit";
import { useAction } from "./common";
import { ImageField } from "./ImageField";

interface Cat {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
}
interface Prod {
  id: string;
  slug: string;
  category_id: string;
  name_ar: string;
  name_en: string;
  description_ar: string;
  seo_title_ar?: string;
  seo_title_en?: string;
  seo_description_ar?: string;
  seo_description_en?: string;
  description_en: string;
  instructions_ar: string;
  instructions_en: string;
  warranty_ar: string;
  warranty_en: string;
  search_terms: string;
  image_url: string | null;
  cover_url?: string | null;
  unit_ar?: string;
  unit_en?: string;
  kind: Kind;
  active: boolean;
  featured: boolean;
  sort: number;
  /** auto: the supplier or stock delivers; manual: the team does; review: the supplier does, the team releases it. */
  delivery?: Delivery;
  after_fields?: AfterFieldDef[];
  /** null: automatic (New, Best seller when earned); "none": never a badge. */
  badge?: ProductBadge | "none" | null;
}
type Delivery = "auto" | "manual" | "review";
interface Off {
  id: string;
  product_id: string;
  name_ar: string;
  name_en: string;
  sort: number;
  supplier_id: string | null;
  supplier_ref: string | null;
  cost_cents: number | null;
  price_cents: number;
  markup_mode: MarkupMode;
  markup_value: string | number;
  round_to_cents: number;
  min_margin_pct: string | number;
  input_fields: InputField[];
  max_quantity: number;
  active: boolean;
  paused_reason: string | null;
  remind_after_days: number | null;
  stock_available: number;
  warranty_ar?: string | null;
  warranty_en?: string | null;
  /** Listed first in its product (virtual numbers: the owner's favourite countries). */
  pinned?: boolean;
}
interface Sup {
  id: string;
  name: string;
  enabled: boolean;
  /** Defaults for packages imported from this supplier (Admin → Suppliers → Settings). */
  import_markup_pct?: string | number;
  import_min_margin_pct?: string | number;
  import_round_to_cents?: number;
}
interface CatalogData {
  categories: Cat[];
  products: Prod[];
  offers: Off[];
  suppliers: Sup[];
}

type Editing =
  | { kind: "product"; product: Prod | null }
  | { kind: "offer"; product: Prod; offer: Off | null; preset?: Partial<OfferDraft> }
  | { kind: "stock"; offer: Off };

export function Catalog() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<CatalogData>("/api/admin/catalog");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [q, setQ] = useState("");

  const close = () => {
    setEditing(null);
    invalidate("/api/catalog");
    void reload();
  };

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 320 }} />;
  const products = data.products.filter((p) => !q || matchesQuery(`${p.name_ar} ${p.name_en} ${p.slug} ${p.search_terms}`, q));

  return (
    <div className="stack">
      <div className="toolbar">
        <input className="input" style={{ maxWidth: 320, minHeight: 42 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchLabel")} />
        <div className="wrap">
          {data.suppliers
            .filter((s) => s.enabled)
            .map((s) => (
              <a key={s.id} className="btn btn--xs btn--ghost press" href={`/admin/suppliers/choose/${s.id}`} onClick={linkHandler(`/admin/suppliers/choose/${s.id}`)}>
                {t("choosePackages")}: {s.name}
              </a>
            ))}
          <button type="button" className="btn btn--sm press" onClick={() => setEditing({ kind: "product", product: null })}>
            <PlusIcon size={18} />
            {t("newProduct")}
          </button>
        </div>
      </div>

      {products.length === 0 && <Empty>{t("none")}</Empty>}
      {data.categories.map((c) => {
        const list = products.filter((p) => p.category_id === c.id);
        if (!list.length) return null;
        return (
          <section key={c.id} className="stack-sm">
            <h2>{pick(lang, c.name_ar, c.name_en)}</h2>
            {list.map((p) => (
              <ProductBlock key={p.id} p={p} offers={data.offers.filter((o) => o.product_id === p.id)} onEdit={setEditing} />
            ))}
          </section>
        );
      })}

      {editing?.kind === "product" && <ProductEditor product={editing.product} categories={data.categories} onClose={close} />}
      {editing?.kind === "offer" && <OfferEditor product={editing.product} offer={editing.offer} preset={editing.preset} suppliers={data.suppliers} onClose={close} />}
      {editing?.kind === "stock" && <StockEditor offer={editing.offer} onClose={close} />}
    </div>
  );
}

function ProductBlock({ p, offers, onEdit }: { p: Prod; offers: Off[]; onEdit: (e: Editing) => void }) {
  const { t, lang } = useT();
  return (
    <div className="card card--pad stack-sm">
      <div className="row-between">
        <div className="wrap">
          <strong>{pick(lang, p.name_ar, p.name_en)}</strong>
          <span className="small muted num">/{p.slug}</span>
          <span className={p.active ? "badge badge--good" : "badge"}>{p.active ? t("active") : "—"}</span>
          {p.featured && <span className="badge">{t("featuredFlag")}</span>}
          {p.badge && p.badge !== "none" && <span className={`badge badge--${p.badge}`}>{t(`badge_${p.badge}`)}</span>}
          {p.delivery && p.delivery !== "auto" && <span className="badge badge--warn">✋ {t(`delivery_${p.delivery}`)}</span>}
          {(p.after_fields?.length ?? 0) > 0 && <span className="badge">{t("afterCount", { n: p.after_fields!.length })}</span>}
        </div>
        <div className="wrap">
          <button type="button" className="btn btn--xs btn--ghost press" onClick={() => onEdit({ kind: "product", product: p })}>
            {t("edit")}
          </button>
          <button type="button" className="btn btn--xs press" onClick={() => onEdit({ kind: "offer", product: p, offer: null })}>
            {t("newOffer")}
          </button>
        </div>
      </div>
      {offers.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("package")}</th>
                <th>{t("supplier")}</th>
                <th>{t("cost")}</th>
                <th>{t("price")}</th>
                <th>{t("status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id} style={{ opacity: o.active ? 1 : 0.55 }}>
                  <td>
                    {o.pinned && <span title={t("pinTop")}>📌 </span>}
                    <bdi>{pick(lang, o.name_ar, o.name_en)}</bdi>
                    {pick(lang, o.warranty_ar ?? "", o.warranty_en ?? "") && (
                      <span className="small muted"> · {pick(lang, o.warranty_ar ?? "", o.warranty_en ?? "")}</span>
                    )}
                  </td>
                  <td className="small">
                    {o.supplier_id ? (
                      <>
                        {o.supplier_id} <span className="muted num">· {o.supplier_ref}</span>
                      </>
                    ) : p.delivery === "manual" ? (
                      t("delivery_manual")
                    ) : (
                      <>
                        {t("manualStock")} <span className="num">({o.stock_available})</span>
                      </>
                    )}
                  </td>
                  <td className="num muted">{o.cost_cents === null ? "—" : usd(o.cost_cents)}</td>
                  <td className="num">{usd(o.price_cents)}</td>
                  <td>{o.paused_reason ? <span className="badge badge--warn">{o.paused_reason}</span> : o.active ? <span className="badge badge--good">✓</span> : "—"}</td>
                  <td>
                    <div className="wrap">
                      <button type="button" className="btn btn--xs btn--ghost press" onClick={() => onEdit({ kind: "offer", product: p, offer: o })}>
                        {t("edit")}
                      </button>
                      {!o.supplier_id && p.delivery !== "manual" && (
                        <button type="button" className="btn btn--xs btn--ghost press" onClick={() => onEdit({ kind: "stock", offer: o })}>
                          {t("addStock")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── product editor

function ProductEditor({ product, categories, onClose }: { product: Prod | null; categories: Cat[]; onClose: () => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const [f, setF] = useState({
    slug: product?.slug ?? "",
    categoryId: product?.category_id ?? categories[0]?.id ?? "",
    nameAr: product?.name_ar ?? "",
    nameEn: product?.name_en ?? "",
    kind: product?.kind ?? ("id" as Kind),
    active: product?.active ?? false,
    featured: product?.featured ?? false,
    sort: product?.sort ?? 0,
    imageUrl: product?.image_url ?? "",
    coverUrl: product?.cover_url ?? "",
    unitAr: product?.unit_ar ?? "",
    unitEn: product?.unit_en ?? "",
    descriptionAr: product?.description_ar ?? "",
    descriptionEn: product?.description_en ?? "",
    instructionsAr: product?.instructions_ar ?? "",
    instructionsEn: product?.instructions_en ?? "",
    warrantyAr: product?.warranty_ar ?? "",
    warrantyEn: product?.warranty_en ?? "",
    searchTerms: product?.search_terms ?? "",
    seoTitleAr: product?.seo_title_ar ?? "",
    seoTitleEn: product?.seo_title_en ?? "",
    seoDescriptionAr: product?.seo_description_ar ?? "",
    seoDescriptionEn: product?.seo_description_en ?? "",
    delivery: product?.delivery ?? ("auto" as Delivery),
    badge: (product?.badge ?? "") as ProductBadge | "none" | "",
    afterFields: product?.after_fields ?? ([] as AfterFieldDef[]),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    const body = {
      ...f, imageUrl: f.imageUrl.trim() || null, coverUrl: f.coverUrl.trim() || null, unitAr: f.unitAr.trim(), unitEn: f.unitEn.trim(),
      slug: f.slug.trim().toLowerCase(), badge: f.badge || null,
    };
    const ok = product
      ? await action.run<{ renamed?: number }>(`/api/admin/products/${product.id}`, { method: "PATCH", body })
      : await action.run<{ id: string }>(`/api/admin/products`, { body });
    // A new unit renames this product's packages named by their amount ("60" → "60 UC").
    const renamed = ok && "renamed" in ok ? Number(ok.renamed ?? 0) : 0;
    if (renamed > 0) toast(t("unitRenamed", { n: renamed }));
    if (ok) onClose();
  }

  const text = (k: keyof typeof f, label: string, opts: { dir?: "ltr" | "rtl"; area?: boolean } = {}) => (
    <label className={opts.area ? "field span-2" : "field"}>
      <span>{label}</span>
      {opts.area ? (
        <textarea className="textarea" dir={opts.dir} value={String(f[k])} onChange={(e) => set(k, e.target.value as never)} />
      ) : (
        <input className="input" dir={opts.dir} value={String(f[k])} onChange={(e) => set(k, e.target.value as never)} />
      )}
    </label>
  );

  return (
    <Sheet
      onClose={onClose}
      label={product ? t("edit") : t("newProduct")}
      foot={
        <button type="button" className="btn btn--block press" onClick={save} disabled={action.busy || !f.slug || !f.nameAr || !f.nameEn || !f.categoryId}>
          {action.busy ? <Spinner small /> : t("save")}
        </button>
      }
    >
      <div className="form-grid">
        {text("nameAr", t("nameAr"), { dir: "rtl" })}
        {text("nameEn", t("nameEn"), { dir: "ltr" })}
        {text("slug", t("slug"), { dir: "ltr" })}
        <label className="field">
          <span>{t("category")}</span>
          <select className="select" value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {pick(lang, c.name_ar, c.name_en)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("kind")}</span>
          <select className="select" value={f.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
            {(["id", "code", "account", "link", "sms"] as const).map((k) => (
              <option key={k} value={k}>
                {t(`kind_${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("sort")}</span>
          <input className="input num" inputMode="numeric" value={f.sort} onChange={(e) => set("sort", Number(e.target.value.replace(/[^\d-]/g, "")) || 0)} />
        </label>
        {text("searchTerms", t("searchTerms"))}
        <div className="span-2 form-grid" style={{ gap: 12 }}>
          <ImageField label={t("imageUrl")} hint={t("imageSquareHint")} value={f.imageUrl} onChange={(v) => set("imageUrl", v)} shape="square" />
          <ImageField label={t("coverUrl")} hint={t("coverHint")} value={f.coverUrl} onChange={(v) => set("coverUrl", v)} shape="wide" />
        </div>
        <label className="field">
          <span>{t("unitAr")}</span>
          <input className="input" dir="rtl" maxLength={24} value={f.unitAr} onChange={(e) => set("unitAr", e.target.value)} placeholder="شدة" />
        </label>
        <label className="field">
          <span>{t("unitEn")}</span>
          <input className="input" dir="ltr" maxLength={24} value={f.unitEn} onChange={(e) => set("unitEn", e.target.value)} placeholder="UC" />
          <span className="hint">{t("unitHint", { example: f.unitEn.trim() ? `60 ${f.unitEn.trim()}` : "60 UC" })}</span>
        </label>
        <label className="field">
          <span>{t("badge")}</span>
          <select className="select" value={f.badge} onChange={(e) => set("badge", e.target.value as ProductBadge | "none" | "")}>
            <option value="">{t("badgeAuto")}</option>
            <option value="none">{t("badgeNone")}</option>
            {(["instant", "new", "hot", "best", "sale"] as const).map((b) => (
              <option key={b} value={b}>
                {t(`badge_${b}`)}
              </option>
            ))}
          </select>
          <span className="hint">{t("badgeHint")}</span>
        </label>
        <label className="field span-2">
          <span>{t("delivery")}</span>
          <select className="select" value={f.delivery} onChange={(e) => set("delivery", e.target.value as Delivery)}>
            {(["auto", "manual", "review"] as const).map((d) => (
              <option key={d} value={d}>
                {t(`delivery_${d}`)}
              </option>
            ))}
          </select>
          <span className="hint">{t(`delivery_${f.delivery}_hint`)}</span>
        </label>
        <div className="span-2">
          <AfterFieldsEditor fields={f.afterFields} onChange={(v) => set("afterFields", v)} />
        </div>
        <div className="pref-row">
          <span>{t("active")}</span>
          <Switch checked={f.active} onChange={(v) => set("active", v)} label={t("active")} />
        </div>
        <div className="pref-row">
          <span>{t("featuredFlag")}</span>
          <Switch checked={f.featured} onChange={(v) => set("featured", v)} label={t("featuredFlag")} />
        </div>
        {text("descriptionAr", t("descriptionAr"), { dir: "rtl", area: true })}
        {text("descriptionEn", t("descriptionEn"), { dir: "ltr", area: true })}
        {text("instructionsAr", `${t("instructions")} (AR)`, { dir: "rtl", area: true })}
        {text("instructionsEn", `${t("instructions")} (EN)`, { dir: "ltr", area: true })}
        {text("warrantyAr", `${t("warranty")} (AR)`, { dir: "rtl", area: true })}
        {text("warrantyEn", `${t("warranty")} (EN)`, { dir: "ltr", area: true })}
        <details className="span-2 seo-details" open={!!(f.seoTitleAr || f.seoTitleEn || f.seoDescriptionAr || f.seoDescriptionEn)}>
          <summary>{t("prodSeoTitle")}</summary>
          <p className="small muted">{t("prodSeoHint")}</p>
          <div className="form-grid">
            <label className="field">
              <span>{t("seoTitleAr")}</span>
              <input className="input" dir="rtl" maxLength={70} value={f.seoTitleAr} onChange={(e) => set("seoTitleAr", e.target.value)} />
            </label>
            <label className="field">
              <span>{t("seoTitleEn")}</span>
              <input className="input" dir="ltr" maxLength={70} value={f.seoTitleEn} onChange={(e) => set("seoTitleEn", e.target.value)} />
            </label>
            <label className="field">
              <span>{t("seoDescAr")}</span>
              <textarea className="textarea" dir="rtl" maxLength={320} value={f.seoDescriptionAr} onChange={(e) => set("seoDescriptionAr", e.target.value)} />
            </label>
            <label className="field">
              <span>{t("seoDescEn")}</span>
              <textarea className="textarea" dir="ltr" maxLength={320} value={f.seoDescriptionEn} onChange={(e) => set("seoDescriptionEn", e.target.value)} />
            </label>
          </div>
        </details>
      </div>
    </Sheet>
  );
}

// ───────────────────────────── offer editor

interface OfferDraft {
  nameAr: string;
  nameEn: string;
  supplierId: string;
  supplierRef: string;
  cost: string;
  markupMode: MarkupMode;
  markupValue: string;
  roundToCents: string;
  minMarginPct: string;
  price: string;
  maxQuantity: string;
  remindDays: string;
  active: boolean;
  sort: string;
  fields: InputField[];
  warrantyAr: string;
  warrantyEn: string;
  pinned: boolean;
}

function OfferEditor({ product, offer, preset, suppliers, onClose }: { product: Prod; offer: Off | null; preset?: Partial<OfferDraft>; suppliers: Sup[]; onClose: () => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const [d, setD] = useState<OfferDraft>({
    nameAr: offer?.name_ar ?? "",
    nameEn: offer?.name_en ?? "",
    supplierId: offer?.supplier_id ?? "",
    supplierRef: offer?.supplier_ref ?? "",
    cost: offer?.cost_cents == null ? "" : (offer.cost_cents / 100).toFixed(2),
    markupMode: offer?.markup_mode ?? "percent",
    // Fixed markups are stored in cents and edited in dollars.
    markupValue: String(offer ? (offer.markup_mode === "fixed" ? Number(offer.markup_value) / 100 : Number(offer.markup_value)) : 15),
    roundToCents: String(offer?.round_to_cents ?? 1),
    minMarginPct: String(offer ? Number(offer.min_margin_pct) : 5),
    price: offer ? (offer.price_cents / 100).toFixed(2) : "",
    maxQuantity: String(offer?.max_quantity ?? 1),
    remindDays: offer?.remind_after_days ? String(offer.remind_after_days) : "",
    active: offer?.active ?? true,
    sort: String(offer?.sort ?? 0),
    fields: offer?.input_fields ?? [],
    warrantyAr: offer?.warranty_ar ?? "",
    warrantyEn: offer?.warranty_en ?? "",
    pinned: offer?.pinned ?? false,
    ...preset,
  });
  const set = <K extends keyof OfferDraft>(k: K, v: OfferDraft[K]) => setD((x) => ({ ...x, [k]: v }));

  const costCents = d.cost.trim() ? dollarsToCents(d.cost) : null;
  const markupValue = Number(d.markupValue) || 0;
  const rounding = Math.max(1, Math.round(Number(d.roundToCents) || 1));
  const minMargin = Number(d.minMarginPct) || 0;
  const preview = useMemo(() => {
    if (d.markupMode === "manual") return dollarsToCents(d.price);
    if (costCents === null) return null;
    const value = d.markupMode === "fixed" ? Math.round(markupValue * 100) : markupValue;
    return priceFromCost(costCents, { mode: d.markupMode, value, roundToCents: rounding, minMarginPct: minMargin });
  }, [d.markupMode, d.price, costCents, markupValue, rounding, minMargin]);
  const floor = costCents !== null ? minimumPrice(costCents, minMargin) : null;
  const tooLow = d.markupMode === "manual" && preview !== null && floor !== null && preview < floor;

  async function save() {
    const pricing = {
      markupMode: d.markupMode,
      markupValue: d.markupMode === "fixed" ? Math.round(markupValue * 100) : markupValue,
      roundToCents: rounding,
      minMarginPct: minMargin,
      ...(d.markupMode === "manual" ? { priceCents: dollarsToCents(d.price) ?? 0 } : {}),
    };
    const common = {
      nameAr: d.nameAr,
      nameEn: d.nameEn,
      maxQuantity: Math.max(1, Math.min(100, Number(d.maxQuantity) || 1)),
      remindAfterDays: Number(d.remindDays) >= 1 ? Math.min(365, Math.round(Number(d.remindDays))) : null,
      sort: Number(d.sort) || 0,
      active: d.active,
      inputFields: d.fields.filter((x) => x.key.trim() && x.labelEn.trim()),
      warrantyAr: d.warrantyAr.trim() || null,
      warrantyEn: d.warrantyEn.trim() || null,
      ...pricing,
    };
    const ok = offer
      ? await action.run(`/api/admin/offers/${offer.id}`, { method: "PATCH", body: { ...(offer.supplier_id ? common : { ...common, costCents }), pinned: d.pinned } })
      : await action.run(`/api/admin/products/${product.id}/offers`, {
          body: { ...common, ...(d.supplierId ? { supplierId: d.supplierId, supplierRef: d.supplierRef.trim() } : {}), ...(costCents !== null ? { costCents } : {}) },
        });
    if (ok) onClose();
  }

  async function resume() {
    if (offer && (await action.run(`/api/admin/offers/${offer.id}`, { method: "PATCH", body: { clearPause: true } }))) onClose();
  }

  const updateField = (i: number, patch: Partial<InputField>) => set("fields", d.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Sheet
      onClose={onClose}
      label={`${pick(lang, product.name_ar, product.name_en)} · ${offer ? t("edit") : t("newOffer")}`}
      foot={
        <>
          {preview !== null && (
            <div className="row-between">
              <span className="muted">{t("price")}</span>
              <span className={tooLow ? "num bad" : "num"} style={{ fontWeight: 700, fontSize: 18 }}>
                {usd(preview)}
                {costCents !== null && preview > 0 && <span className="small muted"> · {Math.round(((preview - costCents) / preview) * 1000) / 10}%</span>}
              </span>
            </div>
          )}
          {tooLow && floor !== null && <span className="error-text">min {usd(floor)}</span>}
          <button type="button" className="btn btn--block press" onClick={save} disabled={action.busy || !d.nameAr || !d.nameEn || preview === null || tooLow || (!offer && !!d.supplierId && !d.supplierRef)}>
            {action.busy ? <Spinner small /> : t("save")}
          </button>
        </>
      }
    >
      {offer?.paused_reason && (
        <div className="card card--pad row-between">
          <span className="warn">
            {t("paused")}: {offer.paused_reason}
          </span>
          <button type="button" className="btn btn--xs press" onClick={resume}>
            {t("resume")}
          </button>
        </div>
      )}
      <div className="form-grid">
        <label className="field">
          <span>{t("nameAr")}</span>
          <input className="input" dir="rtl" value={d.nameAr} onChange={(e) => set("nameAr", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("nameEn")}</span>
          <input className="input" dir="ltr" value={d.nameEn} onChange={(e) => set("nameEn", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("supplier")}</span>
          <select className="select" value={d.supplierId} disabled={!!offer} onChange={(e) => set("supplierId", e.target.value)}>
            <option value="">{t("manualStock")}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {d.supplierId && (
          <label className="field">
            <span>{t("supplierRef")}</span>
            <input className="input num" dir="ltr" value={d.supplierRef} disabled={!!offer} onChange={(e) => set("supplierRef", e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>{t("cost")} (USD)</span>
          <input className="input num" inputMode="decimal" value={d.cost} disabled={!!offer && !!offer.supplier_id} onChange={(e) => set("cost", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("markup")}</span>
          <select className="select" value={d.markupMode} onChange={(e) => set("markupMode", e.target.value as MarkupMode)}>
            <option value="percent">{t("m_percent")}</option>
            <option value="fixed">{t("m_fixed")}</option>
            <option value="manual">{t("m_manual")}</option>
          </select>
        </label>
        {d.markupMode === "manual" ? (
          <label className="field">
            <span>{t("price")} (USD)</span>
            <input className="input num" inputMode="decimal" value={d.price} onChange={(e) => set("price", e.target.value)} />
          </label>
        ) : (
          <label className="field">
            <span>
              {t("markupValue")} {d.markupMode === "percent" ? "%" : "(USD)"}
            </span>
            <input className="input num" inputMode="decimal" value={d.markupValue} onChange={(e) => set("markupValue", e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>{t("minMargin")}</span>
          <input className="input num" inputMode="decimal" value={d.minMarginPct} onChange={(e) => set("minMarginPct", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("rounding")}</span>
          <input className="input num" inputMode="numeric" value={d.roundToCents} onChange={(e) => set("roundToCents", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("maxQty")}</span>
          <input className="input num" inputMode="numeric" value={d.maxQuantity} onChange={(e) => set("maxQuantity", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("sort")}</span>
          <input className="input num" inputMode="numeric" value={d.sort} onChange={(e) => set("sort", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("remindAfter")}</span>
          <input className="input num" inputMode="numeric" value={d.remindDays} placeholder="—" onChange={(e) => set("remindDays", e.target.value.replace(/\D/g, "").slice(0, 3))} />
          <span className="hint">{t("remindHint")}</span>
        </label>
        <div className="pref-row">
          <span>{t("active")}</span>
          <Switch checked={d.active} onChange={(v) => set("active", v)} label={t("active")} />
        </div>
        {offer && (
          <div className="pref-row">
            <span className="stack-sm" style={{ gap: 2 }}>
              <span>{t("pinTop")}</span>
              <span className="hint">{t("pinTopHint")}</span>
            </span>
            <Switch checked={d.pinned} onChange={(v) => set("pinned", v)} label={t("pinTop")} />
          </div>
        )}
        <label className="field">
          <span>{t("pkgWarrantyAr")}</span>
          <input className="input" dir="rtl" maxLength={40} value={d.warrantyAr} onChange={(e) => set("warrantyAr", e.target.value)} placeholder="ضمان كامل" />
        </label>
        <label className="field">
          <span>{t("pkgWarrantyEn")}</span>
          <input className="input" dir="ltr" maxLength={40} value={d.warrantyEn} onChange={(e) => set("warrantyEn", e.target.value)} placeholder="Full warranty" />
        </label>
        <div className="wrap span-2" style={{ gap: 6 }}>
          {(
            [
              ["ضمان كامل", "Full warranty"],
              ["بدون ضمان", "No warranty"],
              ["ضمان 30 يوماً", "30-day warranty"],
            ] as const
          ).map(([ar, en]) => (
            <button key={en} type="button" className="chip chip--sm press" onClick={() => setD((x) => ({ ...x, warrantyAr: ar, warrantyEn: en }))}>
              {pick(lang, ar, en)}
            </button>
          ))}
          <span className="hint">{t("pkgWarrantyHint")}</span>
        </div>
      </div>

      <div className="stack-sm">
        <div className="row-between">
          <h3>{t("inputFields")}</h3>
          <button type="button" className="btn btn--xs btn--ghost press" disabled={d.fields.length >= 6} onClick={() => set("fields", [...d.fields, { key: "", labelEn: "", labelAr: "", required: true }])}>
            {t("addField")}
          </button>
        </div>
        {d.fields.map((fld, i) => (
          <div key={i} className="card card--pad form-grid">
            <label className="field">
              <span>{t("fieldKey")}</span>
              {/* Kept exactly as the supplier names it ("Player_ID", "رقم المشترك"): the supplier reads it back. */}
              <input className="input num" dir="auto" value={fld.key} onChange={(e) => updateField(i, { key: e.target.value.replace(/[^\p{L}\p{M}\p{N}_ .()/:-]/gu, "").slice(0, 48) })} placeholder="player_id" />
            </label>
            <label className="field">
              <span>{t("fieldPattern")}</span>
              <input className="input num" dir="ltr" value={fld.pattern ?? ""} onChange={(e) => updateField(i, { pattern: e.target.value || undefined })} placeholder="^[0-9]{5,12}$" />
            </label>
            <label className="field">
              <span>{t("fieldLabelAr")}</span>
              <input className="input" dir="rtl" value={fld.labelAr ?? ""} onChange={(e) => updateField(i, { labelAr: e.target.value })} />
            </label>
            <label className="field">
              <span>{t("fieldLabelEn")}</span>
              <input className="input" dir="ltr" value={fld.labelEn} onChange={(e) => updateField(i, { labelEn: e.target.value })} />
            </label>
            <label className="field span-2">
              <span>{t("fieldChoices")}</span>
              <ChoicesInput options={fld.options} onChange={(options) => updateField(i, { options })} />
              <span className="hint">{t("fieldChoicesHint")}</span>
            </label>
            <div className="pref-row span-2">
              <span>{t("required")}</span>
              <div className="wrap">
                <Switch checked={fld.required} onChange={(v) => updateField(i, { required: v })} label={t("required")} />
                <button type="button" className="btn btn--xs btn--ghost press" onClick={() => set("fields", d.fields.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/** Choices typed as "Asia, Europe, South East Asia": kept as typed, read when the field loses focus. */
function ChoicesInput({ options, onChange }: { options: InputField["options"]; onChange: (o: InputField["options"]) => void }) {
  const [text, setText] = useState(() => (options ?? []).map((o) => o.value).join(", "));
  function commit() {
    const values = [...new Set(text.split(",").map((v) => v.trim()).filter(Boolean))].slice(0, 50);
    const old = new Map((options ?? []).map((o) => [o.value, o]));
    onChange(values.length ? values.map((v) => old.get(v) ?? { value: v }) : undefined);
    setText(values.join(", "));
  }
  return <input className="input" dir="auto" value={text} placeholder="Asia, Europe, America" onChange={(e) => setText(e.target.value)} onBlur={commit} />;
}

// ───────────────────────────── stock

function StockEditor({ offer, onClose }: { offer: Off; onClose: () => void }) {
  const { t } = useT();
  const action = useAction();
  const [text, setText] = useState("");
  const items = text.split("\n").map((s) => s.trim()).filter(Boolean);
  async function save() {
    if (await action.run(`/api/admin/offers/${offer.id}/stock`, { body: { items } }, `+${items.length}`)) onClose();
  }
  return (
    <Sheet
      onClose={onClose}
      label={`${t("addStock")} · ${offer.name_en}`}
      foot={
        <button type="button" className="btn btn--block press" onClick={save} disabled={action.busy || items.length === 0 || items.length > 500}>
          {action.busy ? <Spinner small /> : `${t("addStock")} (${items.length})`}
        </button>
      }
    >
      <p className="small muted">
        {t("stock")}: <span className="num">{offer.stock_available}</span>
      </p>
      <label className="field">
        <span>{t("stockItems")}</span>
        <textarea className="textarea num" dir="ltr" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    </Sheet>
  );
}

// ───────────────────────────── details asked after paying

const AFTER_TYPES: AfterType[] = ["email", "password", "id", "username", "token", "custom"];

/**
 * What a product asks for after paying (products delivered by hand, or a
 * supplier's activation on the customer's account). Labels default to the
 * type's name; a hint says where to find it (where to copy the cookies from).
 */
function AfterFieldsEditor({ fields, onChange }: { fields: AfterFieldDef[]; onChange: (f: AfterFieldDef[]) => void }) {
  const { t } = useT();
  const update = (i: number, patch: Partial<AfterFieldDef>) => onChange(fields.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = (type: AfterType) => onChange([...fields, { type, labelEn: t(`afterType_${type}_en`), labelAr: t(`afterType_${type}_ar`), required: true }]);
  return (
    <div className="card card--pad stack-sm after-editor">
      <div className="stack-sm">
        <h3>{t("afterFields")}</h3>
        <span className="hint">{t("afterFieldsHint")}</span>
      </div>
      {fields.map((fld, i) => (
        <div key={i} className="after-editor__row">
          <select className="select" value={fld.type} aria-label={t("afterType")} onChange={(e) => update(i, { type: e.target.value as AfterType })}>
            {AFTER_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`afterType_${ty}`)}
              </option>
            ))}
          </select>
          <input className="input" dir="rtl" maxLength={60} value={fld.labelAr} aria-label={t("fieldLabelAr")} placeholder={t("fieldLabelAr")} onChange={(e) => update(i, { labelAr: e.target.value })} />
          <input className="input" dir="ltr" maxLength={60} value={fld.labelEn} aria-label={t("fieldLabelEn")} placeholder={t("fieldLabelEn")} onChange={(e) => update(i, { labelEn: e.target.value })} />
          <input className="input after-editor__hint" dir="rtl" maxLength={300} value={fld.hintAr ?? ""} placeholder={t("afterHintAr")} onChange={(e) => update(i, { hintAr: e.target.value })} />
          <input className="input after-editor__hint" dir="ltr" maxLength={300} value={fld.hintEn ?? ""} placeholder={t("afterHintEn")} onChange={(e) => update(i, { hintEn: e.target.value })} />
          <div className="wrap after-editor__end">
            <Switch checked={fld.required} onChange={(v) => update(i, { required: v })} label={t("required")} />
            <span className="small muted">{t("required")}</span>
            <button type="button" className="btn btn--xs btn--ghost press" aria-label={t("remove")} onClick={() => onChange(fields.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        </div>
      ))}
      {fields.length < 8 && (
        <div className="wrap" style={{ gap: 6 }}>
          <span className="small muted">{t("afterAdd")}</span>
          {AFTER_TYPES.map((ty) => (
            <button key={ty} type="button" className="chip chip--sm press" onClick={() => add(ty)}>
              + {t(`afterType_${ty}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
