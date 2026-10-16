/**
 * Admin → Home: the carousel's banners (add, edit, order, schedule, switch off)
 * and the category sections below it (order, icon, show or hide). Owner only.
 */
import { useState } from "react";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import { invalidate, useApi } from "../lib/useApi";
import { CATEGORY_ICON_NAMES, CategoryIcon } from "../ui/icons";
import { Empty, ErrorBox, Seg, Sheet, Spinner, Switch } from "../ui/kit";
import { useAction } from "./common";

interface AdminBanner {
  id: string;
  titleAr: string;
  titleEn: string;
  subtitleAr: string;
  subtitleEn: string;
  ctaAr: string;
  ctaEn: string;
  imageUrl: string | null;
  linkType: "none" | "product" | "category" | "url";
  linkValue: string | null;
  style: "accent" | "dark" | "light";
  sort: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

interface AdminCategory {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  icon: string | null;
  sort: number;
  active: boolean;
  products: number;
}

interface HomeData {
  banners: AdminBanner[];
  categories: AdminCategory[];
}

interface ProductLite {
  slug: string;
  name_ar: string;
  name_en: string;
}

/** yyyy-mm-dd (local day) ↔ ISO. An end date means "until the end of that day". */
function dayToIso(day: string, end: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00`);
  if (end) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function isoToDay(iso: string | null, end: boolean): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (end) d.setDate(d.getDate() - 1);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function HomeAdmin() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<HomeData>("/api/admin/home");
  const catalog = useApi<{ products: ProductLite[] }>("/api/admin/catalog");
  const action = useAction();
  const [editing, setEditing] = useState<AdminBanner | "new" | null>(null);

  const refresh = () => {
    invalidate("/api/catalog");
    void reload();
  };

  async function patchBanner(b: AdminBanner, body: Record<string, unknown>) {
    if (await action.run(`/api/admin/banners/${b.id}`, { method: "PATCH", body })) refresh();
  }

  /** Swap with the neighbour above or below (sorts are renumbered in steps of 10). */
  async function moveBanner(i: number, dir: -1 | 1) {
    const list = data?.banners ?? [];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const order = list.map((b) => b.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (const [k, id] of order.entries()) {
      const b = list.find((x) => x.id === id)!;
      if (b.sort !== (k + 1) * 10) await action.run(`/api/admin/banners/${id}`, { method: "PATCH", body: { sort: (k + 1) * 10 } }, t("saved"));
    }
    refresh();
  }

  async function patchCategory(c: AdminCategory, body: Record<string, unknown>) {
    if (await action.run(`/api/admin/categories/${c.id}`, { method: "PATCH", body })) refresh();
  }

  async function moveCategory(i: number, dir: -1 | 1) {
    const list = data?.categories ?? [];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const order = list.map((c) => c.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (const [k, id] of order.entries()) {
      const c = list.find((x) => x.id === id)!;
      if (c.sort !== (k + 1) * 10) await action.run(`/api/admin/categories/${id}`, { method: "PATCH", body: { sort: (k + 1) * 10 } }, t("saved"));
    }
    refresh();
  }

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 320 }} />;
  const now = Date.now();
  return (
    <div className="stack">
      <section className="card card--pad stack-sm">
        <div className="row-between">
          <div>
            <h2>{t("banners")}</h2>
            <p className="hint">{t("bannersHint")}</p>
          </div>
          <button type="button" className="btn btn--sm press" onClick={() => setEditing("new")}>
            {t("newBanner")}
          </button>
        </div>
        {data.banners.length === 0 ? (
          <Empty>{t("noBanners")}</Empty>
        ) : (
          <div className="list">
            {data.banners.map((b, i) => {
              const upcoming = b.startsAt && Date.parse(b.startsAt) > now;
              const over = b.endsAt && Date.parse(b.endsAt) <= now;
              return (
                <div key={b.id} className="list-row" style={{ opacity: b.active && !over ? 1 : 0.55 }}>
                  <span className={`banner-thumb slide--${b.style}`} aria-hidden="true">
                    {b.imageUrl && <img src={b.imageUrl} alt="" loading="lazy" />}
                  </span>
                  <span className="list-row__main">
                    <span className="list-row__title">{pick(lang, b.titleAr, b.titleEn)}</span>
                    <span className="list-row__meta">
                      {b.linkType === "none" ? t("linkNone") : `${t(`link_${b.linkType}`)}: ${b.linkValue}`}
                      {upcoming ? ` · ${t("bannerUpcoming")}` : over ? ` · ${t("bannerOver")}` : ""}
                    </span>
                  </span>
                  <div className="wrap" style={{ flexWrap: "nowrap" }}>
                    <button type="button" className="icon-btn press" disabled={i === 0 || action.busy} onClick={() => moveBanner(i, -1)} aria-label={t("moveUp")}>↑</button>
                    <button type="button" className="icon-btn press" disabled={i === data.banners.length - 1 || action.busy} onClick={() => moveBanner(i, 1)} aria-label={t("moveDown")}>↓</button>
                    <Switch checked={b.active} onChange={(v) => patchBanner(b, { active: v })} label={t("enabled")} />
                    <button type="button" className="btn btn--xs btn--ghost press" onClick={() => setEditing(b)}>
                      {t("edit")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card card--pad stack-sm">
        <div>
          <h2>{t("homeSections")}</h2>
          <p className="hint">{t("homeSectionsHint")}</p>
        </div>
        <div className="list">
          {data.categories.map((c, i) => (
            <div key={c.id} className="list-row" style={{ opacity: c.active ? 1 : 0.55 }}>
              <label className="cat-icon-pick" title={t("icon")}>
                <span className="catbar__icon" style={{ width: 42, height: 42, borderRadius: 14 }}>
                  <CategoryIcon name={c.icon} size={22} />
                </span>
                <select aria-label={t("icon")} value={c.icon ?? ""} onChange={(e) => patchCategory(c, { icon: e.target.value || null })}>
                  <option value="">—</option>
                  {CATEGORY_ICON_NAMES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <span className="list-row__main">
                <span className="list-row__title">{pick(lang, c.nameAr, c.nameEn)}</span>
                <span className="list-row__meta">{c.products === 1 ? t("productsOne") : t("productsCount", { n: c.products })}</span>
              </span>
              <div className="wrap" style={{ flexWrap: "nowrap" }}>
                <button type="button" className="icon-btn press" disabled={i === 0 || action.busy} onClick={() => moveCategory(i, -1)} aria-label={t("moveUp")}>↑</button>
                <button type="button" className="icon-btn press" disabled={i === data.categories.length - 1 || action.busy} onClick={() => moveCategory(i, 1)} aria-label={t("moveDown")}>↓</button>
                <Switch checked={c.active} onChange={(v) => patchCategory(c, { active: v })} label={t("showOnHome")} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {editing && (
        <BannerSheet
          banner={editing === "new" ? null : editing}
          categories={data.categories}
          products={catalog.data?.products ?? []}
          onClose={(changed) => {
            setEditing(null);
            if (changed) refresh();
          }}
        />
      )}
    </div>
  );
}

function BannerSheet({ banner, categories, products, onClose }: { banner: AdminBanner | null; categories: AdminCategory[]; products: ProductLite[]; onClose: (changed: boolean) => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const [titleAr, setTitleAr] = useState(banner?.titleAr ?? "");
  const [titleEn, setTitleEn] = useState(banner?.titleEn ?? "");
  const [subAr, setSubAr] = useState(banner?.subtitleAr ?? "");
  const [subEn, setSubEn] = useState(banner?.subtitleEn ?? "");
  const [ctaAr, setCtaAr] = useState(banner?.ctaAr ?? "");
  const [ctaEn, setCtaEn] = useState(banner?.ctaEn ?? "");
  const [image, setImage] = useState(banner?.imageUrl ?? "");
  const [style, setStyle] = useState<AdminBanner["style"]>(banner?.style ?? "accent");
  const [linkType, setLinkType] = useState<AdminBanner["linkType"]>(banner?.linkType ?? "none");
  const [linkValue, setLinkValue] = useState(banner?.linkValue ?? "");
  const [starts, setStarts] = useState(isoToDay(banner?.startsAt ?? null, false));
  const [ends, setEnds] = useState(isoToDay(banner?.endsAt ?? null, true));

  const imageOk = !image.trim() || /^https:\/\/\S{4,}$/.test(image.trim());
  const linkOk = linkType === "none" || (linkType === "url" ? /^(https:\/\/\S{4,}|\/\S*)$/.test(linkValue.trim()) : linkValue !== "");
  const datesOk = !starts || !ends || starts <= ends;
  const ok = titleAr.trim() && titleEn.trim() && imageOk && linkOk && datesOk;

  async function save() {
    if (!ok) return;
    const body = {
      titleAr: titleAr.trim(),
      titleEn: titleEn.trim(),
      subtitleAr: subAr.trim(),
      subtitleEn: subEn.trim(),
      ctaAr: ctaAr.trim(),
      ctaEn: ctaEn.trim(),
      imageUrl: image.trim() || null,
      style,
      linkType,
      linkValue: linkType === "none" ? null : linkValue.trim(),
      startsAt: starts ? dayToIso(starts, false) : null,
      endsAt: ends ? dayToIso(ends, true) : null,
    };
    const r = banner ? await action.run(`/api/admin/banners/${banner.id}`, { method: "PATCH", body }) : await action.run("/api/admin/banners", { body });
    if (r) onClose(true);
  }

  async function remove() {
    if (banner && (await action.run(`/api/admin/banners/${banner.id}`, { method: "DELETE" }, t("deleted")))) onClose(true);
  }

  const preview = {
    title: (lang === "ar" ? titleAr : titleEn) || t("bannerTitle"),
    sub: lang === "ar" ? subAr : subEn,
    cta: (lang === "ar" ? ctaAr : ctaEn) || (linkType !== "none" ? t("shopNow") : ""),
  };
  return (
    <Sheet
      onClose={() => onClose(false)}
      label={banner ? t("editBanner") : t("newBanner")}
      foot={
        <div className="wrap" style={{ width: "100%", flexWrap: "nowrap" }}>
          {banner && (
            <button type="button" className="btn btn--sm btn--ghost press" disabled={action.busy} onClick={remove}>
              {t("delete")}
            </button>
          )}
          <button type="button" className="btn btn--block press" disabled={!ok || action.busy} onClick={save}>
            {action.busy ? <Spinner small /> : t("save")}
          </button>
        </div>
      }
    >
      {/* Live preview, drawn like the store's carousel. */}
      <div className={`slide slide--${style}${imageOk && image.trim() ? " slide--image" : ""}`} style={{ flexBasis: "auto", minHeight: 150 }}>
        {imageOk && image.trim() && <img className="slide__bg" src={image.trim()} alt="" />}
        <div className="slide__text">
          <h2 className="slide__title" style={{ fontSize: 20 }}>{preview.title}</h2>
          {preview.sub && <p className="slide__sub">{preview.sub}</p>}
          {preview.cta && <span className="slide__cta">{preview.cta}</span>}
        </div>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>{t("bannerTitle")} (ع)</span>
          <input className="input" dir="rtl" maxLength={80} value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("bannerTitle")} (EN)</span>
          <input className="input" dir="ltr" maxLength={80} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("bannerText")} (ع)</span>
          <input className="input" dir="rtl" maxLength={160} value={subAr} onChange={(e) => setSubAr(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("bannerText")} (EN)</span>
          <input className="input" dir="ltr" maxLength={160} value={subEn} onChange={(e) => setSubEn(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("bannerButton")} (ع)</span>
          <input className="input" dir="rtl" maxLength={24} value={ctaAr} onChange={(e) => setCtaAr(e.target.value)} placeholder={t("shopNow")} />
        </label>
        <label className="field">
          <span>{t("bannerButton")} (EN)</span>
          <input className="input" dir="ltr" maxLength={24} value={ctaEn} onChange={(e) => setCtaEn(e.target.value)} placeholder="Shop now" />
        </label>
      </div>

      <label className="field">
        <span>{t("bannerImage")}</span>
        <input className="input" dir="ltr" value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" aria-invalid={!imageOk || undefined} />
        <span className="hint">{t("bannerImageHint")}</span>
      </label>
      <div className="pref-row">
        <span>{t("bannerStyle")}</span>
        <Seg
          label={t("bannerStyle")}
          value={style}
          onChange={setStyle}
          options={[
            { value: "accent", label: t("style_accent") },
            { value: "dark", label: t("style_dark") },
            { value: "light", label: t("style_light") },
          ]}
        />
      </div>

      <label className="field">
        <span>{t("bannerOpens")}</span>
        <select className="select" value={linkType} onChange={(e) => { setLinkType(e.target.value as AdminBanner["linkType"]); setLinkValue(""); }}>
          <option value="none">{t("linkNone")}</option>
          <option value="product">{t("link_product")}</option>
          <option value="category">{t("link_category")}</option>
          <option value="url">{t("link_url")}</option>
        </select>
      </label>
      {linkType === "product" && (
        <select className="select" value={linkValue} onChange={(e) => setLinkValue(e.target.value)} aria-label={t("link_product")}>
          <option value="">{t("chooseProduct")}</option>
          {products.map((p) => (
            <option key={p.slug} value={p.slug}>
              {pick(lang, p.name_ar, p.name_en)}
            </option>
          ))}
        </select>
      )}
      {linkType === "category" && (
        <select className="select" value={linkValue} onChange={(e) => setLinkValue(e.target.value)} aria-label={t("link_category")}>
          <option value="">{t("chooseCategory")}</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {pick(lang, c.nameAr, c.nameEn)}
            </option>
          ))}
        </select>
      )}
      {linkType === "url" && (
        <input className="input" dir="ltr" value={linkValue} onChange={(e) => setLinkValue(e.target.value)} placeholder="https://t.me/…" aria-invalid={!linkOk || undefined} />
      )}

      <div className="form-grid">
        <label className="field">
          <span>{t("startsAt")}</span>
          <input className="input num" type="date" value={starts} onChange={(e) => setStarts(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("expiresAt")}</span>
          <input className="input num" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} aria-invalid={!datesOk || undefined} />
        </label>
      </div>
      <p className="hint">{t("bannerDatesHint")}</p>
    </Sheet>
  );
}
