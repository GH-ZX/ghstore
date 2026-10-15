/** Store home: search, today's pick, category chips and the product grid. */
import { useDeferredValue, useMemo, useState } from "react";
import { matchesQuery } from "@store/core";
import { usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { back, linkHandler, match, navigate, usePath } from "../lib/router";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import type { Category, ProductCard } from "../lib/types";
import { BoltIcon, SearchIcon } from "../ui/icons";
import { Empty, ErrorBox, Money, PageLoading, Tile } from "../ui/kit";
import { Shell } from "../ui/Shell";
import { ProductSheet } from "./ProductSheet";

interface Catalog {
  categories: Category[];
  products: ProductCard[];
}

export function Store() {
  const { t, lang } = useT();
  const path = usePath();
  const open = match("/p/:slug", path);
  const { data, error, loading, reload } = useApi<Catalog>("/api/catalog");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const query = useDeferredValue(q);

  const products = useMemo(() => {
    const all = data?.products ?? [];
    return all
      .filter((p) => !cat || p.category === cat)
      .filter((p) => !query.trim() || matchesQuery(`${p.nameAr} ${p.nameEn} ${p.slug} ${p.searchTerms}`, query));
  }, [data, cat, query]);

  const usedCats = useMemo(() => {
    const present = new Set((data?.products ?? []).map((p) => p.category));
    return (data?.categories ?? []).filter((c) => present.has(c.slug));
  }, [data]);

  const hero = !query && !cat ? data?.products.find((p) => p.featured) : undefined;

  return (
    <Shell title={t("store")}>
      <div className="stack screen">
        <label className="search">
          <SearchIcon />
          <span className="sr-only">{t("searchLabel")}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")} enterKeyHint="search" />
        </label>

        {loading && !data && <PageLoading />}
        <ErrorBox error={data ? null : error} onRetry={reload} />

        {hero && (
          <div className="hero">
            <div className="hero__text">
              <span className="badge">{t("featured")}</span>
              <div className="hero__name">{pick(lang, hero.nameAr, hero.nameEn)}</div>
              <button type="button" className="btn btn--sm press" onClick={() => navigate(`/p/${hero.slug}`)}>
                {t("buyNow")} · <span className="num">{usd(hero.fromCents)}</span>
              </button>
            </div>
            <Tile name={hero.nameEn} imageUrl={hero.imageUrl} />
          </div>
        )}

        {usedCats.length > 1 && (
          <div className="chip-row" role="group" aria-label={t("category")}>
            <button type="button" className="chip press" aria-pressed={cat === ""} onClick={() => setCat("")}>
              {t("all")}
            </button>
            {usedCats.map((c) => (
              <button key={c.slug} type="button" className="chip press" aria-pressed={cat === c.slug} onClick={() => setCat(c.slug)}>
                {pick(lang, c.nameAr, c.nameEn)}
              </button>
            ))}
          </div>
        )}

        {data && (
          <>
            <div className="row-between">
              <h2>{t("allProducts")}</h2>
              <span className="small muted">{products.length === 1 ? t("productsOne") : t("productsCount", { n: products.length })}</span>
            </div>
            {products.length === 0 ? (
              <Empty>{t("noProducts")}</Empty>
            ) : (
              <div className="grid">
                {products.map((p) => (
                  <ProductTile key={p.id} p={p} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {open && <ProductSheet slug={open.slug!} onClose={() => back("/")} />}
    </Shell>
  );
}

function ProductTile({ p }: { p: ProductCard }) {
  const { t, lang } = useT();
  const name = pick(lang, p.nameAr, p.nameEn);
  const to = `/p/${p.slug}`;
  return (
    <div className="product">
      <a href={to} onClick={linkHandler(to)}>
        <Tile name={p.nameEn} imageUrl={p.imageUrl} />
        <span className="product__body">
          <span className="product__name">{name}</span>
          <span className="product__rule" />
          <span className="row-between">
            <span className="product__price">
              <span className="small">{t("from")}</span>
              <Money cents={p.fromCents} />
            </span>
            <span className="badge badge--good">{t(`kind_${p.kind}`)}</span>
          </span>
        </span>
      </a>
      <span className="product__flag" aria-hidden="true">
        <BoltIcon />
        {t("instant")}
      </span>
    </div>
  );
}
