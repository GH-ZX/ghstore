/**
 * Admin → Suppliers → Names: how items of suppliers that write shorthand
 * (BatStore: "Capcut pro 1M FW", ProdSeller) are named for the store. The
 * owner's word list on one side, the supplier's items named with it on the
 * other, updated as the list changes; saving renames the saved supplier lists
 * (Choose packages), never products already on sale.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFail } from "../lib/api";
import { usd } from "../lib/format";
import { errorText, pick } from "../lib/i18n";
import { linkHandler } from "../lib/router";
import { toast, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { ShieldIcon } from "../ui/icons";
import { Empty, ErrorBox, Spinner, Switch } from "../ui/kit";
import { useAction } from "./common";

interface Word {
  from: string;
  en: string;
  ar: string;
  part: "product" | "package";
}

interface Named {
  ref: string;
  name: string;
  available: boolean;
  costCents: number;
  productEn: string;
  productAr: string;
  packageEn: string;
  packageAr: string;
  warrantyEn: string | null;
  warrantyAr: string | null;
}

interface NamesData {
  words: Word[];
  isDefault: boolean;
  defaults: Word[];
  suppliers: { id: string; name: string; cleanNames: boolean; items: number }[];
  supplierId: string | null;
  items: Named[];
}

export function Names() {
  const { t, lang } = useT();
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const { data, error, reload } = useApi<NamesData>(`/api/admin/names${supplierId ? `?supplier=${supplierId}` : ""}`);
  const [words, setWords] = useState<Word[] | null>(null);
  const [items, setItems] = useState<Named[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [q, setQ] = useState("");
  const action = useAction();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The list being edited starts as the saved one.
  useEffect(() => {
    if (data && words === null) setWords(data.words);
  }, [data, words]);
  useEffect(() => setItems(null), [data]);

  const sid = supplierId ?? data?.supplierId ?? null;
  const dirty = !!data && !!words && JSON.stringify(words) !== JSON.stringify(data.words);

  // Name the items again with the list as it is now (nothing is saved).
  function edit(next: Word[]) {
    setWords(next);
    if (timer.current) clearTimeout(timer.current);
    if (!sid) return;
    timer.current = setTimeout(async () => {
      const usable = next.filter((w) => w.from.trim() && (w.en.trim() || w.part === "package"));
      setPreviewing(true);
      try {
        const r = await api<{ items: Named[] }>("/api/admin/names/preview", { body: { supplierId: sid, words: usable } });
        setItems(r.items);
      } catch (e) {
        toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
      } finally {
        setPreviewing(false);
      }
    }, 450);
  }

  async function save(list: Word[] | null) {
    const usable = list?.filter((w) => w.from.trim() && (w.en.trim() || w.part === "package")) ?? null;
    const r = await action.run<{ renamed: number }>("/api/admin/names", { method: "PUT", body: { words: usable } }, t("namesSaved"));
    if (r) {
      toast(t("namesRenamed", { n: r.renamed }));
      setWords(null);
      void reload();
    }
  }

  async function toggle(id: string, on: boolean) {
    if (await action.run(`/api/admin/suppliers/${id}`, { method: "PATCH", body: { cleanNames: on } })) void reload();
  }

  const shown = useMemo(() => {
    const list = items ?? data?.items ?? [];
    return q ? list.filter((i) => `${i.name} ${i.productEn} ${i.packageEn}`.toLowerCase().includes(q.toLowerCase())) : list;
  }, [items, data, q]);
  const products = useMemo(() => new Set(shown.map((i) => i.productEn.toLowerCase())).size, [shown]);

  if (!data || !words) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 320 }} />;
  const set = (i: number, patch: Partial<Word>) => edit(words.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  return (
    <div className="stack">
      <a className="small" href="/admin/suppliers" onClick={linkHandler("/admin/suppliers")}>
        ← {t("suppliers")}
      </a>
      <div className="stack-sm">
        <h2>{t("namesTitle")}</h2>
        <p className="hint">{t("namesHint")}</p>
      </div>

      <div className="card card--pad stack-sm">
        <strong>{t("namesWho")}</strong>
        {data.suppliers.map((s) => (
          <div key={s.id} className="pref-row">
            <span>
              {s.name} <span className="small muted num">· {t("namesItems", { n: s.items })}</span>
            </span>
            <Switch checked={s.cleanNames} onChange={(v) => void toggle(s.id, v)} label={s.name} />
          </div>
        ))}
      </div>

      <div className="names-layout">
        <section className="card card--pad stack-sm">
          <div className="row-between">
            <strong>{t("namesWords")}</strong>
            <span className="small muted">{data.isDefault && !dirty ? t("namesBuiltIn") : dirty ? t("namesUnsaved") : ""}</span>
          </div>
          <span className="hint">{t("namesWordsHint")}</span>
          <div className="names-words">
            <span className="small muted">{t("namesFrom")}</span>
            <span className="small muted">{t("namesEn")}</span>
            <span className="small muted">{t("namesAr")}</span>
            <span className="small muted">{t("namesPart")}</span>
            <span />
            {words.map((w, i) => (
              <WordRow key={i} w={w} onChange={(p) => set(i, p)} onRemove={() => edit(words.filter((_, j) => j !== i))} />
            ))}
          </div>
          <div className="wrap">
            <button type="button" className="btn btn--xs btn--ghost press" disabled={words.length >= 200} onClick={() => edit([{ from: "", en: "", ar: "", part: "package" }, ...words])}>
              + {t("namesAdd")}
            </button>
            <button type="button" className="btn btn--xs btn--ghost press" onClick={() => edit(data.defaults)}>
              {t("namesDefaults")}
            </button>
          </div>
          <div className="wrap">
            <button type="button" className="btn btn--sm press" disabled={action.busy || !dirty} onClick={() => save(words)}>
              {action.busy ? <Spinner small /> : t("save")}
            </button>
            {dirty && (
              <button type="button" className="btn btn--sm btn--ghost press" onClick={() => { setWords(data.words); setItems(null); }}>
                {t("cancel")}
              </button>
            )}
          </div>
        </section>

        <section className="card card--pad stack-sm">
          <div className="row-between">
            <strong>{t("namesPreview")}</strong>
            {previewing && <Spinner small />}
          </div>
          <div className="toolbar">
            <select className="select" value={sid ?? ""} onChange={(e) => { setSupplierId(e.target.value); setWords(null); }} aria-label={t("supplier")}>
              {data.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input className="input" type="search" style={{ maxWidth: 240, minHeight: 42 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchLabel")} />
          </div>
          <span className="small muted">{t("namesCount", { items: shown.length, products })}</span>
          {shown.length === 0 && <Empty>{t("namesNoItems")}</Empty>}
          <div className="table-wrap">
            <table className="table names-table">
              <thead>
                <tr>
                  <th>{t("namesSupplierName")}</th>
                  <th>{t("product")}</th>
                  <th>{t("package")}</th>
                  <th>{t("cost")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.ref} style={{ opacity: i.available ? 1 : 0.5 }}>
                    <td className="small muted" dir="ltr">
                      {i.name}
                    </td>
                    <td>
                      <strong>{pick(lang, i.productAr, i.productEn)}</strong>
                    </td>
                    <td>
                      {pick(lang, i.packageAr, i.packageEn)}
                      {i.warrantyEn && (
                        <span className="option__note">
                          <ShieldIcon size={11} /> {pick(lang, i.warrantyAr ?? "", i.warrantyEn)}
                        </span>
                      )}
                    </td>
                    <td className="num muted">{usd(i.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

/** One word: what the supplier writes, how the store writes it, and where it goes. */
function WordRow({ w, onChange, onRemove }: { w: Word; onChange: (p: Partial<Word>) => void; onRemove: () => void }) {
  const { t } = useT();
  return (
    <>
      <input className="input" dir="ltr" maxLength={60} value={w.from} aria-label={t("namesFrom")} placeholder="gmail" onChange={(e) => onChange({ from: e.target.value.toLowerCase() })} />
      <input className="input" dir="ltr" maxLength={60} value={w.en} aria-label={t("namesEn")} placeholder="Ready Gmail account" onChange={(e) => onChange({ en: e.target.value })} />
      <input className="input" dir="rtl" maxLength={60} value={w.ar} aria-label={t("namesAr")} placeholder="حساب Gmail جاهز" onChange={(e) => onChange({ ar: e.target.value })} />
      <select className="select" value={w.part} aria-label={t("namesPart")} onChange={(e) => onChange({ part: e.target.value as Word["part"] })}>
        <option value="package">{t("namesPartPackage")}</option>
        <option value="product">{t("namesPartProduct")}</option>
      </select>
      <button type="button" className="btn btn--xs btn--ghost press" aria-label={t("remove")} onClick={onRemove}>
        ✕
      </button>
    </>
  );
}
