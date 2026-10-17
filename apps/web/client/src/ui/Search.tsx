/**
 * Search, opened from the header: the page slides away and a full-screen search
 * takes its place, with the customer's recent searches, what sells now and the
 * categories; typing shows matching products at once. Escape, the back arrow or
 * Telegram's back button closes it.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { matchesQuery } from "@store/core";
import { pick } from "../lib/i18n";
import { isOverlay, navigate } from "../lib/router";
import { useApp, useT } from "../lib/state";
import { pushBack } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import type { Category, ProductCard } from "../lib/types";
import { CategoryIcon, ChevronIcon, CloseIcon, SearchIcon } from "./icons";
import { Money } from "./kit";
import { ProductArt } from "./ProductArt";

const RECENT_KEY = "gh.recent";
const RECENT_MAX = 6;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* storage may be unavailable */
  }
}

/** Popular: the products marked best seller or hot, then the featured, then those with the most packages. */
function popular(products: ProductCard[]): ProductCard[] {
  const rank = (p: ProductCard) => (p.badge === "best" ? 0 : p.badge === "hot" ? 1 : p.featured ? 2 : 3);
  return [...products].sort((a, b) => rank(a) - rank(b) || b.packages - a.packages).slice(0, 6);
}

/** `initial`: a search opened from a link (/?q=…, the home page's search action for search engines and agents). */
export function SearchOverlay({ onClose, initial = "" }: { onClose: () => void; initial?: string }) {
  const { t, lang } = useT();
  const { miniApp } = useApp();
  const { data } = useApi<{ categories: Category[]; products: ProductCard[] }>("/api/catalog");
  const [q, setQ] = useState(initial);
  const query = useDeferredValue(q.trim());
  const [recent, setRecent] = useState(readRecent);
  const [leaving, setLeaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Close with a short exit animation.
  const close = useRef(() => {});
  close.current = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(onClose, 180);
  };

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("searching");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus after the opening animation starts (keeps the keyboard from jumping the page on phones).
    const timer = window.setTimeout(() => input.current?.focus(), 60);
    // A sheet open over the search answers Escape first (and marks it handled).
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && close.current();
    window.addEventListener("keydown", onKey);
    const unBack = miniApp ? pushBack(() => close.current()) : () => {};
    return () => {
      root.classList.remove("searching");
      document.body.style.overflow = overflow;
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      unBack();
    };
  }, [miniApp]);

  const products = useMemo(() => data?.products ?? [], [data]);
  const results = useMemo(
    () => (query ? products.filter((p) => matchesQuery(`${p.nameAr} ${p.nameEn} ${p.slug} ${p.searchTerms}`, query)).slice(0, 40) : []),
    [products, query],
  );
  const categories = useMemo(() => {
    const present = new Set(products.map((p) => p.category));
    return (data?.categories ?? []).filter((c) => present.has(c.slug));
  }, [data, products]);
  const catName = (slug: string) => {
    const c = data?.categories.find((x) => x.slug === slug);
    return c ? pick(lang, c.nameAr, c.nameEn) : "";
  };

  function remember(term: string) {
    const v = term.trim();
    if (v.length < 2) return;
    const next = [v, ...recent.filter((r) => r.toLowerCase() !== v.toLowerCase())].slice(0, RECENT_MAX);
    setRecent(next);
    saveRecent(next);
  }

  function go(to: string) {
    if (query) remember(query);
    // A product opens over the search (closing it brings the results back); a category is a new screen.
    if (!isOverlay(new URL(to, location.origin).pathname)) onClose();
    navigate(to);
  }

  function clearRecent() {
    setRecent([]);
    saveRecent([]);
  }

  const row = (p: ProductCard, i: number) => (
    <button key={p.id} type="button" className="search-row press" style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }} onClick={() => go(`/p/${p.slug}`)}>
      <ProductArt name={p.nameEn} nameAr={p.nameAr} imageUrl={p.imageUrl} className="search-row__pic" width={120} />
      <span className="search-row__main">
        <span className="search-row__name">{pick(lang, p.nameAr, p.nameEn)}</span>
        <span className="small muted">{catName(p.category)}</span>
      </span>
      <span className="search-row__price">
        <span className="small muted">{t("from")}</span>
        <Money cents={p.fromCents} />
      </span>
    </button>
  );

  return (
    <div className={leaving ? "search-overlay search-overlay--out" : "search-overlay"} role="dialog" aria-modal="true" aria-label={t("searchLabel")}>
      <div className="search-overlay__bar">
        <button type="button" className="icon-btn press" onClick={() => close.current()} aria-label={t("searchClose")}>
          <span className="mirror">
            <ChevronIcon />
          </span>
        </button>
        <label className="search-overlay__field">
          <SearchIcon size={18} />
          <span className="sr-only">{t("searchLabel")}</span>
          <input
            ref={input}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                remember(q);
                if (results.length === 1) go(`/p/${results[0]!.slug}`);
                else input.current?.blur();
              }
            }}
            placeholder={t("search")}
            enterKeyHint="search"
            autoComplete="off"
          />
          {q && (
            <button type="button" className="search-overlay__clear press" onClick={() => { setQ(""); input.current?.focus(); }} aria-label={t("searchClear")}>
              <CloseIcon size={14} />
            </button>
          )}
        </label>
      </div>

      <div className="search-overlay__body">
        {query ? (
          <section className="stack-sm">
            <span className="search-overlay__label">{results.length === 1 ? t("productsOne") : t("productsCount", { n: results.length })}</span>
            {results.length === 0 ? (
              <div className="search-empty">
                <SearchIcon size={28} />
                <span>{t("noProducts")}</span>
              </div>
            ) : (
              <div className="search-list">{results.map(row)}</div>
            )}
          </section>
        ) : (
          <>
            {recent.length > 0 && (
              <section className="stack-sm">
                <div className="row-between">
                  <span className="search-overlay__label">{t("searchRecent")}</span>
                  <button type="button" className="btn btn--xs btn--ghost press" onClick={clearRecent}>
                    {t("searchClear")}
                  </button>
                </div>
                <div className="wrap" style={{ gap: 8 }}>
                  {recent.map((r) => (
                    <button key={r} type="button" className="chip press" onClick={() => { setQ(r); input.current?.focus(); }}>
                      {r}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {products.length > 0 && (
              <section className="stack-sm">
                <span className="search-overlay__label">{t("searchPopular")}</span>
                <div className="search-list">{popular(products).map(row)}</div>
              </section>
            )}
            {categories.length > 0 && (
              <section className="stack-sm">
                <span className="search-overlay__label">{t("searchCategories")}</span>
                <div className="wrap" style={{ gap: 8 }}>
                  {categories.map((c) => (
                    <button key={c.slug} type="button" className="chip chip--icon press" onClick={() => go(`/c/${c.slug}`)}>
                      <CategoryIcon name={c.icon} size={16} />
                      {pick(lang, c.nameAr, c.nameEn)}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
