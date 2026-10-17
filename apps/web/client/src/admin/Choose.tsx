/**
 * Admin → Suppliers → Choose packages: everything a supplier offers, ticked
 * where the store sells it. Tick or untick (a whole group at once, or what a
 * filter shows), review exactly what changes, apply. Works for every supplier
 * the same way: how items group into products is each supplier's own
 * (server: supplier-catalogue.ts, selection.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { matchesQuery, priceFromCost } from "@store/core";
import { api, ApiFail } from "../lib/api";
import { usd } from "../lib/format";
import { errorText, pick } from "../lib/i18n";
import { linkHandler, navigate } from "../lib/router";
import { toast, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { CheckIcon, SearchIcon, ShieldIcon } from "../ui/icons";
import { Empty, ErrorBox, Sheet, Spinner } from "../ui/kit";
import { ago } from "./common";

interface Group {
  id: string;
  name: string;
  image: string | null;
  itemsAt: string | null;
  error: string | null;
  missing: boolean;
  /** Items the supplier lists; null until the group is first read. */
  total: number | null;
  chosen: number;
  fresh: number;
  gone: number;
}
interface Frame {
  supplier: { id: string; name: string; enabled: boolean; grouped: boolean; listedAt: string | null; markupPct: number; minMarginPct: number; roundToCents: number; categoryId: string | null };
  version: number;
  error: string | null;
  groups: Group[];
  suppliers: { id: string; name: string; enabled: boolean }[];
  categories: { id: string; name_ar: string; name_en: string }[];
  products: { id: string; category_id: string; name_ar: string; name_en: string; active: boolean }[];
}
interface Offer {
  id: string;
  active: boolean;
  priceCents: number | null;
  costCents: number | null;
  pausedReason: string | null;
  productId: string;
  productAr: string;
  productEn: string;
}
interface Item {
  ref: string;
  name: string;
  packageName: string | null;
  packageNameAr?: string | null;
  warrantyEn?: string | null;
  warrantyAr?: string | null;
  successPct?: number | null;
  productKey: string | null;
  productName: string | null;
  costCents: number;
  available: boolean;
  missing: boolean;
  fresh: boolean;
  offer: Offer | null;
}
interface Plan {
  add: {
    key: string; productId: string | null; categoryId: string | null; nameAr: string; nameEn: string; unitAr?: string; unitEn?: string; isNew: boolean;
    items: { ref: string; name: string; nameAr?: string; costCents: number; priceCents: number; reactivate: boolean }[];
  }[];
  remove: { ref: string; nameAr: string; nameEn: string; productAr: string; productEn: string; action: "delete" | "archive" }[];
  hide: { id: string; nameAr: string; nameEn: string }[];
  show: { id: string; nameAr: string; nameEn: string }[];
}
/** Where a new package goes: into an existing product, or a new one (its category, names and unit). */
type NewProduct = { categoryId?: string; nameAr?: string; nameEn?: string; unitAr?: string; unitEn?: string };
type Place = Record<string, { productId: string } | NewProduct>;

const FILTERS = ["all", "chosen", "not", "new", "changed", "gone"] as const;
type Filter = (typeof FILTERS)[number];
const GROUP_FILTERS = ["all", "chosen", "new"] as const;

const sold = (i: Item) => !!i.offer?.active;
/** What can be ticked: what the supplier sells now, or what the store already sells. */
const selectable = (i: Item) => sold(i) || (i.available && !i.missing);
const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 980px)").matches;

export function Choose({ supplierId }: { supplierId: string }) {
  const { t, lang } = useT();
  const base = `/api/admin/suppliers/${supplierId}`;
  const frame = useApi<Frame>(`${base}/catalogue`);
  const f = frame.data;
  const [group, setGroup] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, Item[]>>({});
  const [loadingGroup, setLoadingGroup] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<Record<string, string | null>>({});
  // The owner's changes, by supplier ref: true = sell it, false = stop.
  const [want, setWant] = useState<Record<string, boolean>>({});
  // Which group each changed ref belongs to, for the counts of groups not open.
  const [refGroup, setRefGroup] = useState<Record<string, string>>({});
  const [gq, setGq] = useState("");
  const [gFilter, setGFilter] = useState<(typeof GROUP_FILTERS)[number]>("all");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [review, setReview] = useState(false);

  // A new supplier: start again.
  useEffect(() => {
    setGroup(null);
    setItems({});
    setWant({});
    setRefGroup({});
    setReview(false);
  }, [supplierId]);

  async function loadGroup(id: string): Promise<Item[] | null> {
    setLoadingGroup(id);
    try {
      const r = await api<{ items: Item[]; error: string | null }>(`${base}/catalogue/items?group=${encodeURIComponent(id)}`);
      setItems((x) => ({ ...x, [id]: r.items }));
      setGroupError((x) => ({ ...x, [id]: r.error }));
      return r.items;
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
      return null;
    } finally {
      setLoadingGroup((g) => (g === id ? null : g));
    }
  }

  // Groups worth seeing first: what the store sells, then what is new.
  const groups = useMemo(() => {
    if (!f) return [];
    return [...f.groups].sort((a, b) => Number(b.chosen > 0) - Number(a.chosen > 0) || Number(b.fresh > 0) - Number(a.fresh > 0));
  }, [f]);

  // Wide screens open the first group by themselves; phones show the list first.
  useEffect(() => {
    if (f && group === null && groups[0] && wide()) setGroup(groups[0].id);
  }, [f, group, groups]);

  useEffect(() => {
    if (group !== null && !items[group] && loadingGroup !== group) void loadGroup(group);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  if (!f) return frame.error ? <ErrorBox error={frame.error} onRetry={frame.reload} /> : <div className="skeleton" style={{ height: 420 }} />;

  const s = f.supplier;
  const chosen = (i: Item) => want[i.ref] ?? sold(i);
  const adds = Object.entries(want).filter(([, v]) => v).map(([r]) => r);
  const removes = Object.entries(want).filter(([, v]) => !v).map(([r]) => r);
  const pending = adds.length + removes.length;

  function setMany(list: Item[], on: boolean, gid: string) {
    setWant((w) => {
      const next = { ...w };
      for (const i of list) {
        if (on && !selectable(i)) continue;
        if (on === sold(i)) delete next[i.ref];
        else next[i.ref] = on;
      }
      return next;
    });
    setRefGroup((x) => ({ ...x, ...Object.fromEntries(list.map((i) => [i.ref, gid])) }));
  }

  /** A group's tick box: sell everything it has, or nothing. Reads the group first if needed. */
  async function toggleGroup(g: Group) {
    const list = items[g.id] ?? (await loadGroup(g.id));
    if (!list) return;
    const pickable = list.filter(selectable);
    const all = pickable.length > 0 && pickable.every(chosen);
    setMany(pickable, !all, g.id);
  }

  function groupState(g: Group): "on" | "off" | "mixed" {
    const list = items[g.id];
    if (list) {
      const p = list.filter(selectable);
      const n = p.filter(chosen).length;
      return n === 0 ? "off" : n === p.length ? "on" : "mixed";
    }
    // Not read yet: only the server's counts (and nothing changed here).
    if (g.chosen === 0) return "off";
    return g.total !== null && g.chosen >= g.total ? "on" : "mixed";
  }

  function groupCount(g: Group): number {
    const list = items[g.id];
    if (list) return list.filter(chosen).length;
    let n = g.chosen;
    for (const [ref, v] of Object.entries(want)) if (refGroup[ref] === g.id) n += v ? 1 : -1;
    return n;
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api<{ ok: boolean; error?: string }>(`${base}/catalogue/refresh`, { method: "POST", body: s.grouped ? {} : { group: "" } });
      if (s.grouped && group) await api(`${base}/catalogue/refresh`, { method: "POST", body: { group } });
      if (r.ok) toast(t("chRefreshed"));
      else toast(t("chReadError", { error: r.error ?? "" }), true);
      setItems({});
      await frame.reload();
      if (group !== null) await loadGroup(group);
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setRefreshing(false);
    }
  }

  function switchSupplier(id: string) {
    if (id === supplierId) return;
    if (pending && !window.confirm(t("chDiscard"))) return;
    navigate(`/admin/suppliers/choose/${id}`, { replace: true });
  }

  async function afterApply() {
    setWant({});
    setRefGroup({});
    setReview(false);
    setItems({});
    await frame.reload();
    if (group !== null) await loadGroup(group);
  }

  const groupName = (g: Group) => (g.id === "" ? (f.groups.length > 1 ? t("chOther") : t("allProducts")) : g.name);
  const shownGroups = groups.filter((g) => {
    if (gq && !matchesQuery(`${g.name} ${g.id}`, gq)) return false;
    if (gFilter === "chosen") return groupCount(g) > 0;
    if (gFilter === "new") return g.fresh > 0;
    return true;
  });
  const current = group === null ? null : f.groups.find((g) => g.id === group) ?? null;
  const list = group === null ? [] : items[group] ?? [];
  const changed = (i: Item) => !!i.offer?.active && i.offer.costCents !== null && i.offer.costCents !== i.costCents && !i.missing;
  const gone = (i: Item) => sold(i) && (i.missing || !i.available);
  const matches = (i: Item, fl: Filter) =>
    fl === "all" ? true : fl === "chosen" ? chosen(i) : fl === "not" ? !chosen(i) : fl === "new" ? i.fresh : fl === "changed" ? changed(i) : gone(i);
  const shown = list.filter((i) => matches(i, filter) && (!q || matchesQuery(`${i.name} ${i.ref}`, q)));
  const counts = Object.fromEntries(FILTERS.map((fl) => [fl, list.filter((i) => matches(i, fl)).length])) as Record<Filter, number>;
  const rule = { mode: "percent" as const, value: s.markupPct, roundToCents: s.roundToCents, minMarginPct: s.minMarginPct };
  const soldAs = list.find((i) => i.offer?.active)?.offer;

  return (
    <div className="stack choose">
      <div className="toolbar">
        <div className="wrap">
          <a className="btn btn--xs btn--ghost press" href="/admin/suppliers" onClick={linkHandler("/admin/suppliers")}>
            <span className="flip-rtl">‹</span> {t("suppliers")}
          </a>
          <h2>{t("choosePackages")}</h2>
        </div>
      </div>

      <div className="chip-row" role="group" aria-label={t("suppliers")}>
        {f.suppliers.map((x) => (
          <button key={x.id} type="button" className="chip chip--sm press" aria-pressed={x.id === supplierId} onClick={() => switchSupplier(x.id)}>
            {x.name}
            {!x.enabled && <span style={{ opacity: 0.7 }}> · {t("supOff")}</span>}
          </button>
        ))}
      </div>

      <div className="choose__status">
        <span>{s.listedAt ? t("chListUpdated", { when: ago(s.listedAt, lang) }) : t("chListNever")}</span>
        {s.grouped && <span>{t("chGroupsCount", { n: f.groups.length })}</span>}
        <button type="button" className="btn btn--xs btn--ghost press" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Spinner small /> : t("chRefresh")}
        </button>
        <span>{t("chPricesFrom", { markup: s.markupPct, margin: s.minMarginPct })}</span>
      </div>
      {!s.enabled && <p className="hint warn">{t("chSupplierOff")}</p>}
      {f.error && <p className="error-text">{t("chReadError", { error: f.error })}</p>}

      <div className="choose__panes" data-open={group !== null}>
        <aside className="choose__groups stack-sm">
          <label className="search">
            <SearchIcon />
            <input type="search" value={gq} onChange={(e) => setGq(e.target.value)} placeholder={t("searchLabel")} aria-label={t("searchLabel")} />
          </label>
          <div className="chip-row choose__chips">
            {GROUP_FILTERS.map((x) => (
              <button key={x} type="button" className="chip chip--sm press" aria-pressed={gFilter === x} onClick={() => setGFilter(x)}>
                {x === "all" ? t("all") : x === "chosen" ? t("chWithChosen") : t("chNew")}
              </button>
            ))}
          </div>
          {shownGroups.length === 0 ? (
            <Empty>{t("none")}</Empty>
          ) : (
            <div className="list">
              {shownGroups.slice(0, 400).map((g) => {
                const st = groupState(g);
                const n = groupCount(g);
                return (
                  <div key={g.id} className="choose__group" aria-current={g.id === group}>
                    <button
                      type="button"
                      className="tick press"
                      data-state={st}
                      aria-label={`${t("chSelectGroup")}: ${groupName(g)}`}
                      aria-pressed={st === "mixed" ? "mixed" : st === "on"}
                      disabled={loadingGroup === g.id}
                      onClick={() => void toggleGroup(g)}
                    >
                      {loadingGroup === g.id ? <Spinner small /> : st === "on" ? <CheckIcon size={14} /> : st === "mixed" ? "–" : null}
                    </button>
                    <button type="button" className="choose__group-main" onClick={() => setGroup(g.id)}>
                      <span className="list-row__main">
                        <span className="list-row__title">{groupName(g)}</span>
                        {(g.gone > 0 || g.fresh > 0 || g.missing) && (
                          <span className="list-row__meta">
                            {g.missing ? <span className="bad">{t("chGoneBadge")}</span> : g.gone > 0 ? <span className="bad">{t("chGoneN", { n: g.gone })}</span> : t("chNewN", { n: g.fresh })}
                          </span>
                        )}
                      </span>
                      <span className={n > 0 ? "choose__count choose__count--on" : "choose__count"}>
                        {g.total === null && !items[g.id] ? (n > 0 ? t("chChosenN", { n }) : "—") : t("chOf", { a: n, b: items[g.id]?.filter(selectable).length ?? g.total ?? 0 })}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        <section className="choose__items stack-sm">
          {current === null ? (
            <Empty>{t("chPickGroup")}</Empty>
          ) : (
            <>
              <div className="card card--pad stack-sm">
                <div className="row-between">
                  <div className="wrap" style={{ minWidth: 0 }}>
                    <button type="button" className="btn btn--xs btn--ghost press choose__back" onClick={() => setGroup(null)}>
                      <span className="flip-rtl">‹</span> {t("back")}
                    </button>
                    <div style={{ minWidth: 0 }}>
                      <h3>{groupName(current)}</h3>
                      <span className="small muted">
                        {t("chOf", { a: list.filter(chosen).length, b: list.filter(selectable).length })}
                        {soldAs && ` · ${t("chSoldAs", { name: pick(lang, soldAs.productAr, soldAs.productEn) })}`}
                        {current.itemsAt && ` · ${ago(current.itemsAt, lang)}`}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="tick press"
                    data-state={groupState(current)}
                    aria-label={`${t("chSelectGroup")}: ${groupName(current)}`}
                    onClick={() => void toggleGroup(current)}
                  >
                    {groupState(current) === "on" ? <CheckIcon size={14} /> : groupState(current) === "mixed" ? "–" : null}
                  </button>
                </div>
                <label className="search">
                  <SearchIcon />
                  <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchLabel")} aria-label={t("searchLabel")} />
                </label>
                <div className="chip-row choose__chips">
                  {FILTERS.filter((fl) => fl === "all" || counts[fl] > 0).map((fl) => (
                    <button key={fl} type="button" className="chip chip--sm press" aria-pressed={filter === fl} onClick={() => setFilter(fl)}>
                      {t(`chF_${fl}`)} <span className="num">{counts[fl]}</span>
                    </button>
                  ))}
                </div>
                <div className="wrap">
                  <button type="button" className="btn btn--xs btn--soft press" disabled={!shown.some((i) => selectable(i) && !chosen(i))} onClick={() => setMany(shown, true, current.id)}>
                    {t("chSelectShown")}
                  </button>
                  <button type="button" className="btn btn--xs btn--ghost press" disabled={!shown.some(chosen)} onClick={() => setMany(shown, false, current.id)}>
                    {t("chDeselectShown")}
                  </button>
                </div>
              </div>

              {groupError[current.id] && <p className="error-text">{t("chReadError", { error: groupError[current.id] ?? "" })}</p>}
              {loadingGroup === current.id && !items[current.id] ? (
                <div className="skeleton" style={{ height: 280 }} />
              ) : shown.length === 0 ? (
                <Empty>{t("chNoItems")}</Empty>
              ) : (
                <div className="list">
                  {shown.map((i) => (
                    <ItemRow
                      key={i.ref}
                      item={i}
                      on={chosen(i)}
                      change={want[i.ref]}
                      price={i.offer?.active && i.offer.priceCents !== null ? i.offer.priceCents : priceFromCost(i.costCents, rule)}
                      changed={changed(i)}
                      gone={gone(i)}
                      replacements={gone(i) ? list.filter((x) => !x.offer && x.available && !x.missing) : []}
                      onToggle={() => setMany([i], !chosen(i), current.id)}
                      onReplaced={afterApply}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {pending > 0 && (
        <div className="choose__bar">
          <span className="wrap" style={{ gap: 10 }}>
            {adds.length > 0 && (
              <span>
                <span className="plus num">+{adds.length}</span> <span className="small">{t("chToAdd")}</span>
              </span>
            )}
            {removes.length > 0 && (
              <span>
                <span className="minus num">−{removes.length}</span> <span className="small">{t("chToRemove")}</span>
              </span>
            )}
          </span>
          <span className="wrap" style={{ gap: 6 }}>
            <button type="button" className="btn btn--sm btn--ghost press" onClick={() => { setWant({}); setRefGroup({}); }}>
              {t("chUndo")}
            </button>
            <button type="button" className="btn btn--sm press" onClick={() => setReview(true)}>
              {t("chReview")}
            </button>
          </span>
        </div>
      )}

      {review && (
        <ReviewSheet
          base={base}
          frame={f}
          add={adds}
          remove={removes}
          onClose={() => setReview(false)}
          onStale={async () => {
            setReview(false);
            toast(t("chStale"), true);
            await frame.reload();
          }}
          onDone={afterApply}
        />
      )}
    </div>
  );
}

function ItemRow({ item: i, on, change, price, changed, gone, replacements, onToggle, onReplaced }: {
  item: Item; on: boolean; change: boolean | undefined; price: number; changed: boolean; gone: boolean;
  replacements: Item[]; onToggle: () => void; onReplaced: () => void;
}) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState(false);
  const can = selectable(i);
  const archived = !!i.offer && !i.offer.active;

  async function replace(ref: string) {
    const to = replacements.find((x) => x.ref === ref);
    if (!to || !i.offer) return;
    setBusy(true);
    try {
      await api(`/api/admin/offers/${i.offer.id}/relink`, { method: "POST", body: { supplierRef: to.ref, costCents: to.costCents } });
      toast(t("relinked"));
      onReplaced();
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(false);
    }
  }

  const badge = gone
    ? <span className="badge badge--bad">{i.missing ? t("chGoneBadge") : t("chUnavailable")}</span>
    : !i.available && !i.offer?.active
      ? <span className="badge">{t("chUnavailable")}</span>
      : changed
        ? <span className="badge badge--warn">{t("chCostChanged")}</span>
        : i.offer?.active && i.offer.pausedReason
          ? <span className="badge badge--warn">{t("chPausedBadge")}</span>
          : i.offer?.active
            ? <span className="badge badge--good">{t("chOnSale")}</span>
            : archived
              ? <span className="badge">{t("chArchived")}</span>
              : i.fresh
                ? <span className="badge">{t("chNew")}</span>
                : null;

  return (
    <div className={`choose__item${change !== undefined ? " choose__item--changed" : ""}${can ? "" : " choose__item--off"}`}>
      <button type="button" className="tick press" data-state={on ? "on" : "off"} disabled={!can && !on} aria-pressed={on} aria-label={i.packageName || i.name} onClick={onToggle}>
        {on ? <CheckIcon size={14} /> : null}
      </button>
      <span className="list-row__main">
        <span className="list-row__title">
          {(lang === "ar" && i.packageNameAr) || i.packageName || i.name}
          {change !== undefined && <span className={change ? "plus small" : "minus small"}> {change ? t("chWillAdd") : t("chWillRemove")}</span>}
        </span>
        <span className="list-row__meta wrap" style={{ gap: 6 }}>
          {badge}
          {typeof i.successPct === "number" && (
            <span className={`option__rate option__rate--${i.successPct >= 60 ? "good" : i.successPct >= 30 ? "mid" : "low"}`}>
              {t("successRate", { n: Math.round(i.successPct) })}
            </span>
          )}
          {i.warrantyEn && (
            <span className="option__note">
              <ShieldIcon size={11} /> {(lang === "ar" && i.warrantyAr) || i.warrantyEn}
            </span>
          )}
          {i.packageName && !i.name.includes(i.packageName) && <span className="choose__ref">{i.name}</span>}
        </span>
        {gone && replacements.length > 0 && (
          <select className="select choose__replace" value="" disabled={busy} aria-label={t("chReplace")} onChange={(e) => e.target.value && void replace(e.target.value)}>
            <option value="">{t("chReplace")}</option>
            {replacements.map((r) => (
              <option key={r.ref} value={r.ref}>
                {r.packageName || r.name} · {usd(r.costCents)}
              </option>
            ))}
          </select>
        )}
      </span>
      <span className="choose__prices">
        <span className="num">{usd(price)}</span>
        <span className="small muted">
          {t("cost")} {changed && i.offer?.costCents != null && <span className="num strike">{usd(i.offer.costCents)}</span>} <span className="num">{usd(i.costCents)}</span>
        </span>
      </span>
    </div>
  );
}

/** The new-product part of a destination's choice (none when it goes into an existing product). */
function newPart(choice: Place[string] | undefined): NewProduct {
  return choice && !("productId" in choice) ? choice : {};
}

function ReviewSheet({ base, frame, add, remove, onClose, onStale, onDone }: {
  base: string; frame: Frame; add: string[]; remove: string[]; onClose: () => void; onStale: () => void; onDone: () => void;
}) {
  const { t, lang } = useT();
  const [place, setPlace] = useState<Place>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<ApiFail | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(dryRun: boolean): Promise<{ plan: Plan; counts: Record<string, number> } | null> {
    try {
      return await api(`${base}/selection`, { method: "POST", body: { version: frame.version, add, remove, place, dryRun } });
    } catch (e) {
      const f = e instanceof ApiFail ? e : new ApiFail("internal", 0);
      if (f.code === "conflict" && f.field === "version") onStale();
      else if (f.field?.startsWith("item:")) {
        toast(t("chItemGone"), true);
        onClose();
      } else setError(f);
      return null;
    }
  }

  useEffect(() => {
    setError(null);
    void send(true).then((r) => r && setPlan(r.plan));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  async function apply() {
    setBusy(true);
    const r = await send(false);
    setBusy(false);
    if (!r) return;
    toast(t("chApplied", { added: r.counts.added ?? 0, removed: (r.counts.deleted ?? 0) + (r.counts.archived ?? 0) }));
    onDone();
  }

  const nAdd = plan ? plan.add.reduce((s, d) => s + d.items.length, 0) : 0;
  const name = (ar: string, en: string) => pick(lang, ar, en);
  return (
    <Sheet
      onClose={onClose}
      label={t("chReviewTitle", { name: frame.supplier.name })}
      foot={
        <button type="button" className="btn btn--block press" disabled={!plan || busy || nAdd + (plan?.remove.length ?? 0) === 0} onClick={apply}>
          {busy ? <Spinner small /> : nAdd + (plan?.remove.length ?? 0) === 1 ? t("chApply1") : t("chApply", { n: nAdd + (plan?.remove.length ?? 0) })}
        </button>
      }
    >
      <ErrorBox error={error} />
      {!plan && !error && <Spinner />}
      {plan && (
        <>
          {plan.add.length > 0 && <h3 className="plus">{nAdd === 1 ? t("chAdd1") : t("chAddN", { n: nAdd })}</h3>}
          {plan.add.map((d) => (
            <div key={d.key} className="choose__dest">
              <div className="row-between">
                <strong>{name(d.nameAr, d.nameEn)}</strong>
                <span className={d.isNew ? "badge badge--good" : "badge"}>{d.isNew ? t("chNewProduct") : t("chExisting")}</span>
              </div>
              {!d.key.startsWith("o:") && (
                <div className="wrap">
                  {d.isNew && (
                    <label className="wrap small muted" style={{ gap: 6 }}>
                      {t("chPutIn")}
                      <select
                        className="select choose__select"
                        value={d.categoryId ?? ""}
                        onChange={(e) => setPlace((p) => ({ ...p, [d.key]: { ...newPart(p[d.key]), categoryId: e.target.value } }))}
                      >
                        {frame.categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {name(c.name_ar, c.name_en)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="wrap small muted" style={{ gap: 6 }}>
                    {d.isNew ? t("chOrAddTo") : t("chAddTo")}
                    <select
                      className="select choose__select"
                      value={d.isNew ? "" : d.productId ?? ""}
                      onChange={(e) =>
                        setPlace((p) => {
                          const next = { ...p };
                          if (e.target.value) next[d.key] = { productId: e.target.value };
                          else next[d.key] = { ...newPart(p[d.key]), categoryId: frame.supplier.categoryId ?? frame.categories[0]?.id ?? "" };
                          return next;
                        })
                      }
                    >
                      <option value="">{t("chANewProduct")}</option>
                      {frame.products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {name(p.name_ar, p.name_en)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {d.isNew && (
                <div className="form-grid choose__names" key={`${d.key}-names`}>
                  {(
                    [
                      ["nameAr", t("nameAr"), "rtl", 120, d.nameAr],
                      ["nameEn", t("nameEn"), "ltr", 120, d.nameEn],
                      ["unitAr", t("unitAr"), "rtl", 24, d.unitAr ?? ""],
                      ["unitEn", t("unitEn"), "ltr", 24, d.unitEn ?? ""],
                    ] as const
                  ).map(([k, label, dir, max, value]) => (
                    <label key={k} className="field">
                      <span className="small">{label}</span>
                      <input
                        className="input choose__input"
                        dir={dir}
                        maxLength={max}
                        defaultValue={value}
                        placeholder={k === "unitEn" ? t("unitExampleEn") : k === "unitAr" ? t("unitExampleAr") : undefined}
                        // Saved when you leave the field: the preview below follows.
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v === value || (!v && k.startsWith("name"))) return;
                          setPlace((p) => ({ ...p, [d.key]: { ...newPart(p[d.key]), [k]: v } }));
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              <ul>
                {d.items.map((i) => (
                  <li key={i.ref}>
                    {lang === "ar" ? i.nameAr ?? i.name : i.name} <span className="num muted">{usd(i.costCents)} → {usd(i.priceCents)}</span>
                    {i.reactivate && <span className="small muted"> · {t("chComesBack")}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {plan.remove.length > 0 && (
            <>
              <h3 className="minus">{plan.remove.length === 1 ? t("chRemove1") : t("chRemoveN", { n: plan.remove.length })}</h3>
              <div className="choose__dest">
                <ul>
                  {plan.remove.map((r) => (
                    <li key={r.ref}>
                      {name(r.productAr, r.productEn) === name(r.nameAr, r.nameEn) ? name(r.nameAr, r.nameEn) : `${name(r.productAr, r.productEn)} · ${name(r.nameAr, r.nameEn)}`} — <strong>{r.action === "delete" ? t("chDeleted") : t("chArchivedVerb")}</strong>{" "}
                      <span className="small muted">({r.action === "delete" ? t("chNeverOrdered") : t("chArchivedNote")})</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          {plan.hide.map((p) => (
            <p key={p.id} className="small warn">
              {name(p.nameAr, p.nameEn)}: {t("chHidden")}
            </p>
          ))}
          {plan.show.map((p) => (
            <p key={p.id} className="small good">
              {name(p.nameAr, p.nameEn)}: {t("chShown")}
            </p>
          ))}
          <p className="hint">{t("chPricedHint")}</p>
        </>
      )}
    </Sheet>
  );
}
