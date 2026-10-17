/**
 * Admin → SEO & pages: how the store shows up in Google and in shared links (the
 * home page's title and description, the share picture, the verification codes,
 * a switch to keep the store out of search results), the links to give Google
 * Search Console, and the store's own pages (terms, privacy, refund and more).
 * Products have their own search title and description in Catalog.
 */
import { useEffect, useState } from "react";
import { store } from "@store/config";
import { api, ApiFail } from "../lib/api";
import { useCopy } from "../lib/hooks";
import { errorText, pick } from "../lib/i18n";
import { toast, useT } from "../lib/state";
import { openExternal } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import { Prose } from "../screens/Legal";
import { askConfirm } from "../ui/Confirm";
import { ErrorBox, Seg, Sheet, Spinner, Switch } from "../ui/kit";
import { useAction } from "./common";
import { ImageField } from "./ImageField";

interface SettingsData {
  settings: Record<string, unknown>;
}

interface AdminPage {
  slug: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  published: boolean;
  inFooter: boolean;
  sort: number;
  builtIn: boolean;
  edited: boolean;
  updatedAt: string;
}

export function SeoAdmin() {
  return (
    <div className="stack">
      <SearchCard />
      <ConsoleCard />
      <AnalyticsCard />
      <PagesCard />
    </div>
  );
}

// ───────────────────────────── the home page in search results

const FIELDS = {
  titleAr: "seo.title_ar",
  titleEn: "seo.title_en",
  descriptionAr: "seo.description_ar",
  descriptionEn: "seo.description_en",
  imageUrl: "seo.image_url",
  google: "seo.google_verification",
  bing: "seo.bing_verification",
} as const;
type Field = keyof typeof FIELDS;
type Form = Record<Field, string> & { indexing: boolean };

function fromSettings(s: Record<string, unknown>): Form {
  const text = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
  return {
    titleAr: text(FIELDS.titleAr), titleEn: text(FIELDS.titleEn), descriptionAr: text(FIELDS.descriptionAr), descriptionEn: text(FIELDS.descriptionEn),
    imageUrl: text(FIELDS.imageUrl), google: text(FIELDS.google), bing: text(FIELDS.bing), indexing: s["seo.indexing"] !== false,
  };
}

/** A verification code: the meta tag's content when the whole tag was pasted. */
const codeOf = (v: string) => (/content=["']([^"']+)["']/.exec(v)?.[1] ?? v).trim();

function SearchCard() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<SettingsData>("/api/admin/settings");
  const [saved, setSaved] = useState<Form | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data && !f) {
      const form = fromSettings(data.settings);
      setSaved(form);
      setF(form);
    }
  }, [data, f]);

  if (!f || !saved) {
    return (
      <section className="card card--pad stack-sm">
        <h2>{t("seoSearchTitle")}</h2>
        <ErrorBox error={error} onRetry={reload} />
        {!error && <div className="skeleton" style={{ height: 220 }} />}
      </section>
    );
  }
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => (x ? { ...x, [k]: v } : x));
  const tagline = store.tagline[lang];
  const shownTitle = (lang === "ar" ? f.titleAr : f.titleEn).trim() || `${store.name} | ${tagline.replace(/[.。]$/, "")}`;
  const shownDesc = (lang === "ar" ? f.descriptionAr : f.descriptionEn).trim() || tagline;
  const changed = (Object.keys(FIELDS) as Field[]).filter((k) => f[k].trim() !== saved[k].trim());
  const dirty = changed.length > 0 || f.indexing !== saved.indexing;

  async function save() {
    if (!f) return;
    setBusy(true);
    try {
      for (const k of changed) {
        const raw = k === "google" || k === "bing" ? codeOf(f[k]) : f[k].trim();
        await api(`/api/admin/settings/${FIELDS[k]}`, { method: "PUT", body: { value: raw || null } });
      }
      if (f.indexing !== saved?.indexing) await api("/api/admin/settings/seo.indexing", { method: "PUT", body: { value: f.indexing } });
      const next = { ...f, google: codeOf(f.google), bing: codeOf(f.bing) };
      setSaved(next);
      setF(next);
      toast(t("saved"));
    } catch (e) {
      const x = e instanceof ApiFail ? e : new ApiFail("internal", 0);
      toast(`${errorText(lang, x.code)}${x.field ? ` (${x.field})` : ""}`, true);
    } finally {
      setBusy(false);
    }
  }

  const input = (k: "titleAr" | "titleEn", dir: "rtl" | "ltr", label: string) => (
    <label className="field">
      <span className="row-between">
        <span>{label}</span>
        <span className={`seo-count${f[k].length > 60 ? " seo-count--over" : ""}`}>{f[k].length}/60</span>
      </span>
      <input className="input" dir={dir} maxLength={70} value={f[k]} placeholder={`${store.name} | ${store.tagline[dir === "rtl" ? "ar" : "en"]}`} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const area = (k: "descriptionAr" | "descriptionEn", dir: "rtl" | "ltr", label: string) => (
    <label className="field">
      <span className="row-between">
        <span>{label}</span>
        <span className={`seo-count${f[k].length > 160 ? " seo-count--over" : ""}`}>{f[k].length}/160</span>
      </span>
      <textarea className="textarea" dir={dir} maxLength={320} value={f[k]} placeholder={store.tagline[dir === "rtl" ? "ar" : "en"]} onChange={(e) => set(k, e.target.value)} />
    </label>
  );

  return (
    <section className="card card--pad stack">
      <div>
        <h2>{t("seoSearchTitle")}</h2>
        <p className="hint">{t("seoSearchHint")}</p>
      </div>
      {/* What a Google result for the home page will look like. */}
      <div className="seo-preview" dir={lang === "ar" ? "rtl" : "ltr"} aria-label={t("seoPreview")}>
        <span className="seo-preview__site">
          <span className="seo-preview__icon" aria-hidden="true">{store.mark.slice(0, 2)}</span>
          <span>
            <b>{store.name}</b>
            <small dir="ltr">{store.url.replace(/^https:\/\//, "")}</small>
          </span>
        </span>
        <span className="seo-preview__title">{shownTitle}</span>
        <span className="seo-preview__desc">{shownDesc.length > 160 ? `${shownDesc.slice(0, 157)}…` : shownDesc}</span>
      </div>
      <div className="form-grid">
        {input("titleAr", "rtl", t("seoTitleAr"))}
        {input("titleEn", "ltr", t("seoTitleEn"))}
        {area("descriptionAr", "rtl", t("seoDescAr"))}
        {area("descriptionEn", "ltr", t("seoDescEn"))}
        <div className="span-2">
          <ImageField label={t("seoImage")} hint={t("seoImageHint")} value={f.imageUrl} onChange={(v) => set("imageUrl", v)} shape="wide" />
        </div>
        <div className="pref-row span-2">
          <span className="stack-xs">
            <span>{t("seoIndexing")}</span>
            <span className="small muted">{t("seoIndexingHint")}</span>
          </span>
          <Switch checked={f.indexing} onChange={(v) => set("indexing", v)} label={t("seoIndexing")} />
        </div>
        <label className="field">
          <span>{t("seoGoogle")}</span>
          <input className="input input--mono" dir="ltr" value={f.google} placeholder="google-site-verification" onChange={(e) => set("google", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("seoBing")}</span>
          <input className="input input--mono" dir="ltr" value={f.bing} placeholder="msvalidate.01" onChange={(e) => set("bing", e.target.value)} />
        </label>
        <p className="small muted span-2">{t("seoVerifyHint")}</p>
      </div>
      <button type="button" className="btn btn--block press" disabled={!dirty || busy} onClick={() => void save()}>
        {busy ? <Spinner small /> : t("save")}
      </button>
    </section>
  );
}

// ───────────────────────────── Search Console

function ConsoleCard() {
  const { t } = useT();
  const copy = useCopy();
  const sitemap = `${store.url}/sitemap.xml`;
  const enc = encodeURIComponent(`${store.url}/`);
  const tools = [
    { label: t("seoOpenConsole"), href: "https://search.google.com/search-console" },
    { label: t("seoRichTest"), href: `https://search.google.com/test/rich-results?url=${enc}` },
    { label: t("seoSpeedTest"), href: `https://pagespeed.web.dev/analysis?url=${enc}` },
    { label: "Bing Webmaster", href: "https://www.bing.com/webmasters" },
  ];
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("seoConsoleTitle")}</h2>
        <p className="hint">{t("seoConsoleHint")}</p>
      </div>
      <div className="copy-box">
        <code dir="ltr">{sitemap}</code>
        <button type="button" className="btn btn--sm btn--soft press" onClick={() => void copy(sitemap)}>
          {t("copy")}
        </button>
      </div>
      <div className="wrap" style={{ gap: 8 }}>
        <a className="btn btn--xs btn--ghost press" href={sitemap} target="_blank" rel="noopener">sitemap.xml</a>
        <a className="btn btn--xs btn--ghost press" href={`${store.url}/robots.txt`} target="_blank" rel="noopener">robots.txt</a>
        {tools.map((x) => (
          <button key={x.href} type="button" className="btn btn--xs btn--ghost press" onClick={() => openExternal(x.href)}>
            {x.label}
          </button>
        ))}
      </div>
    </section>
  );
}

// ───────────────────────────── visitor statistics

/** The token from Cloudflare's snippet ({"token": "…"}), or what was typed. */
const tokenOf = (v: string) => (/"token"\s*:\s*"([a-f0-9]{32})"/.exec(v)?.[1] ?? v).trim().toLowerCase();

function AnalyticsCard() {
  const { t } = useT();
  const action = useAction();
  const { data } = useApi<SettingsData>("/api/admin/settings");
  const [token, setToken] = useState<string | null>(null);
  const saved = typeof data?.settings["analytics.cf_token"] === "string" ? (data.settings["analytics.cf_token"] as string) : "";
  const value = token ?? saved;
  const clean = tokenOf(value);
  const ok = !clean || /^[a-f0-9]{32}$/.test(clean);

  async function save() {
    const r = await action.run("/api/admin/settings/analytics.cf_token", { method: "PUT", body: { value: clean || null } });
    if (r) setToken(clean);
  }

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("analyticsTitle")}</h2>
        <p className="hint">{t("analyticsHint")}</p>
      </div>
      <label className="field">
        <span>{t("analyticsToken")}</span>
        <input className="input input--mono" dir="ltr" value={value} placeholder="0123456789abcdef0123456789abcdef" aria-invalid={!ok} onChange={(e) => setToken(e.target.value)} />
      </label>
      <div className="wrap" style={{ gap: 8 }}>
        <button type="button" className="btn btn--sm press" disabled={action.busy || !ok || clean === saved} onClick={() => void save()}>
          {action.busy ? <Spinner small /> : t("save")}
        </button>
        <button type="button" className="btn btn--sm btn--ghost press" onClick={() => openExternal("https://dash.cloudflare.com/?to=/:account/web-analytics")}>
          {t("analyticsOpen")}
        </button>
      </div>
      {saved && <p className="small good">{t("analyticsOn")}</p>}
    </section>
  );
}

// ───────────────────────────── the store's pages

function PagesCard() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<{ pages: AdminPage[] }>("/api/admin/pages");
  const [pages, setPages] = useState<AdminPage[] | null>(null);
  const [editing, setEditing] = useState<AdminPage | "new" | null>(null);
  useEffect(() => {
    if (data) setPages(data.pages);
  }, [data]);

  return (
    <section className="card card--pad stack-sm">
      <div className="row-between">
        <div>
          <h2>{t("pagesTitle")}</h2>
          <p className="hint">{t("pagesHint")}</p>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!pages && !error && <div className="skeleton" style={{ height: 160 }} />}
      {pages && (
        <div className="list">
          {pages.map((p) => (
            <div key={p.slug} className="list-row">
              <span className="list-row__main">
                <span className="list-row__title">{pick(lang, p.titleAr, p.titleEn)}</span>
                <span className="list-row__meta">
                  <bdi dir="ltr">/legal/{p.slug}</bdi> · {p.builtIn && !p.edited ? t("pageBuiltIn") : t("pageEdited")}
                  {!p.published && ` · ${t("pageHidden")}`}
                  {p.published && !p.inFooter && ` · ${t("pageNoFooter")}`}
                </span>
              </span>
              <span className="wrap" style={{ gap: 6 }}>
                {p.published && (
                  <a className="btn btn--xs btn--ghost press" href={`/legal/${p.slug}`} target="_blank" rel="noopener">
                    {t("open")}
                  </a>
                )}
                <button type="button" className="btn btn--xs btn--soft press" onClick={() => setEditing(p)}>
                  {t("edit")}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn btn--sm btn--soft press" style={{ alignSelf: "flex-start" }} onClick={() => setEditing("new")}>
        + {t("pageAdd")}
      </button>
      {editing && (
        <PageEditor
          page={editing === "new" ? null : editing}
          onClose={(next) => {
            if (next) setPages(next);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function PageEditor({ page, onClose }: { page: AdminPage | null; onClose: (pages?: AdminPage[]) => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const [f, setF] = useState({
    slug: page?.slug ?? "",
    titleAr: page?.titleAr ?? "",
    titleEn: page?.titleEn ?? "",
    bodyAr: page?.bodyAr ?? "",
    bodyEn: page?.bodyEn ?? "",
    published: page?.published ?? true,
    inFooter: page?.inFooter ?? true,
  });
  const [tab, setTab] = useState<"ar" | "en">(lang);
  const [preview, setPreview] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const slug = f.slug.trim().toLowerCase();
  const slugOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 60;
  const body = tab === "ar" ? f.bodyAr : f.bodyEn;

  async function save() {
    const r = await action.run<{ pages: AdminPage[] }>(`/api/admin/pages/${slug}`, {
      method: "PUT",
      body: { titleAr: f.titleAr, titleEn: f.titleEn, bodyAr: f.bodyAr, bodyEn: f.bodyEn, published: f.published, inFooter: f.inFooter, ...(page ? { sort: page.sort } : {}) },
    });
    if (r) onClose(r.pages);
  }

  async function remove() {
    if (!page || !(await askConfirm(page.builtIn ? t("pageResetConfirm") : t("pageDeleteConfirm"), { danger: true }))) return;
    const r = await action.run<{ pages: AdminPage[] }>(`/api/admin/pages/${page.slug}`, { method: "DELETE" });
    if (r) onClose(r.pages);
  }

  return (
    <Sheet
      onClose={() => onClose()}
      label={page ? pick(lang, page.titleAr, page.titleEn) : t("pageAdd")}
      foot={
        <div className="stack-sm">
          <button type="button" className="btn btn--block press" disabled={action.busy || !slugOk || !f.titleAr.trim() || !f.titleEn.trim()} onClick={() => void save()}>
            {action.busy ? <Spinner small /> : t("save")}
          </button>
          {page && (page.builtIn ? page.edited : true) && (
            <button type="button" className="btn btn--block btn--ghost press" disabled={action.busy} onClick={() => void remove()}>
              {page.builtIn ? t("pageReset") : t("pageDelete")}
            </button>
          )}
        </div>
      }
    >
      <div className="form-grid">
        {!page && (
          <label className="field span-2">
            <span>{t("pageSlug")}</span>
            <input className="input" dir="ltr" value={f.slug} placeholder="about-us" onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
            <span className="small muted" dir="ltr">{store.url.replace(/^https:\/\//, "")}/legal/{slug || "…"}</span>
          </label>
        )}
        <label className="field">
          <span>{t("seoTitleAr")}</span>
          <input className="input" dir="rtl" maxLength={120} value={f.titleAr} onChange={(e) => set("titleAr", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("seoTitleEn")}</span>
          <input className="input" dir="ltr" maxLength={120} value={f.titleEn} onChange={(e) => set("titleEn", e.target.value)} />
        </label>
        <div className="span-2 row-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <Seg
            value={tab}
            onChange={setTab}
            label={t("pageBody")}
            options={[
              { value: "ar", label: "العربية" },
              { value: "en", label: "English" },
            ]}
          />
          <Seg
            value={preview ? "preview" : "write"}
            onChange={(v) => setPreview(v === "preview")}
            label={t("seoPreview")}
            options={[
              { value: "write", label: t("pageWrite") },
              { value: "preview", label: t("seoPreview") },
            ]}
          />
        </div>
        <div className="span-2">
          {preview ? (
            <div className="page-preview" dir={tab === "ar" ? "rtl" : "ltr"}>
              <Prose source={body} />
            </div>
          ) : (
            <textarea
              className="textarea page-textarea"
              dir={tab === "ar" ? "rtl" : "ltr"}
              value={body}
              onChange={(e) => set(tab === "ar" ? "bodyAr" : "bodyEn", e.target.value)}
            />
          )}
          <p className="small muted" style={{ marginTop: 6 }}>{t("pageMarks")}</p>
        </div>
        <div className="pref-row">
          <span>{t("pagePublished")}</span>
          <Switch checked={f.published} onChange={(v) => set("published", v)} label={t("pagePublished")} />
        </div>
        <div className="pref-row">
          <span>{t("pageInFooter")}</span>
          <Switch checked={f.inFooter} onChange={(v) => set("inFooter", v)} label={t("pageInFooter")} />
        </div>
      </div>
    </Sheet>
  );
}
