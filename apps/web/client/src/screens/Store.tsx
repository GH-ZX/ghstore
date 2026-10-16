/**
 * Store home: search, the showcase (ui/Showcase.tsx), the category bar, then one shelf per
 * category ("See all" opens the category's own page at /c/:slug). Typing in
 * search swaps everything below it for the matching products.
 */
import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import { matchesQuery } from "@store/core";
import { pick } from "../lib/i18n";
import { back, linkHandler, match, navigate, usePath } from "../lib/router";
import { useT } from "../lib/state";
import { openExternal } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import type { Banner, Category, ProductCard } from "../lib/types";
import { BoltIcon, CategoryIcon, ChevronIcon, SearchIcon } from "../ui/icons";
import { Empty, ErrorBox, Money, PageLoading, Tile } from "../ui/kit";
import { Shell } from "../ui/Shell";
import { Showcase, type ShowcaseOptions, type ShowcaseStyle, type SlideData, type SlidePackage } from "../ui/Showcase";
import { ProductSheet } from "./ProductSheet";

interface Catalog {
  categories: Category[];
  products: ProductCard[];
  banners?: Banner[];
  /** The showcase's settings (Admin → Home) and a few packages per "deal" slide product. */
  showcase?: ShowcaseOptions & { style: ShowcaseStyle; packages: Record<string, SlidePackage[]> };
}

export function Store() {
  const { t, lang } = useT();
  const path = usePath();
  const open = match("/p/:slug", path);
  const catPage = match("/c/:slug", path);
  const { data, error, loading, reload } = useApi<Catalog>("/api/catalog");
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());

  const categories = useMemo(() => {
    const present = new Set((data?.products ?? []).map((p) => p.category));
    return (data?.categories ?? []).filter((c) => present.has(c.slug));
  }, [data]);

  const results = useMemo(
    () => (query ? (data?.products ?? []).filter((p) => matchesQuery(`${p.nameAr} ${p.nameEn} ${p.slug} ${p.searchTerms}`, query)) : []),
    [data, query],
  );

  const category = catPage ? (data?.categories ?? []).find((c) => c.slug === catPage.slug) : undefined;
  const title = category ? pick(lang, category.nameAr, category.nameEn) : t("store");

  return (
    <Shell title={title}>
      <div className="stack screen home" key={catPage?.slug ?? "home"}>
        <label className="search">
          <SearchIcon />
          <span className="sr-only">{t("searchLabel")}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")} enterKeyHint="search" />
        </label>

        {loading && !data && <PageLoading />}
        <ErrorBox error={data ? null : error} onRetry={reload} />

        {data && query && <Results products={results} />}
        {data && !query && catPage && <CategoryPage slug={catPage.slug!} category={category} products={data.products} />}
        {data && !query && !catPage && <Home data={data} categories={categories} />}
      </div>
      {open && <ProductSheet slug={open.slug!} onClose={() => back("/")} />}
    </Shell>
  );
}

function Home({ data, categories }: { data: Catalog; categories: Category[] }) {
  const { t, lang } = useT();
  const featured = data.products.filter((p) => p.featured);
  const banners = data.banners ?? [];
  return (
    <>
      <HomeShowcase data={data} />

      {categories.length > 1 && (
        <nav className="catbar" aria-label={t("category")}>
          {categories.map((c) => {
            const to = `/c/${c.slug}`;
            return (
              <a key={c.slug} href={to} onClick={linkHandler(to)} className="catbar__item press">
                <span className="catbar__icon">
                  <CategoryIcon name={c.icon} size={26} />
                </span>
                <span className="catbar__label">{pick(lang, c.nameAr, c.nameEn)}</span>
              </a>
            );
          })}
        </nav>
      )}

      {banners.length > 0 && featured.length > 0 && (
        <Shelf title={t("todaysPicks")} icon={<BoltIcon size={16} />} products={featured} />
      )}

      {categories.map((c) => {
        const items = data.products.filter((p) => p.category === c.slug);
        return (
          <Shelf
            key={c.slug}
            title={pick(lang, c.nameAr, c.nameEn)}
            icon={<CategoryIcon name={c.icon} size={18} />}
            products={items}
            more={items.length > 4 ? `/c/${c.slug}` : undefined}
            count={items.length}
          />
        );
      })}
    </>
  );
}

// ───────────────────────────── showcase (carousel)

function openLink(link: Banner["link"]): (() => void) | null {
  if (!link) return null;
  if (link.type === "product") return () => navigate(`/p/${link.value}`);
  if (link.type === "category") return () => navigate(`/c/${link.value}`);
  if (link.value.startsWith("/")) return () => navigate(link.value);
  return () => openExternal(link.value);
}

/**
 * The slides: the banners from Admin → Home (a banner that opens a product shows
 * that product's art, and its packages in the "deal" look); without banners,
 * the featured products; without those, the products with the most to choose from.
 */
function useSlides(data: Catalog): SlideData[] {
  const { t, lang } = useT();
  const fallback: ShowcaseStyle = data.showcase?.style ?? "cinematic";
  const banners = data.banners ?? [];
  const bySlug = new Map(data.products.map((p) => [p.slug, p]));
  const packages = data.showcase?.packages ?? {};
  const deal = (p: ProductCard | undefined) =>
    p
      ? {
          packages: packages[p.slug] ?? [],
          packageCount: p.packages,
          goPackage: (id: string) => navigate(`/p/${p.slug}?offer=${encodeURIComponent(id)}`),
        }
      : {};
  const catName = (slug: string) => {
    const c = data.categories.find((x) => x.slug === slug);
    return c ? pick(lang, c.nameAr, c.nameEn) : undefined;
  };
  if (banners.length) {
    return banners.map((b) => {
      const p = b.link?.type === "product" ? bySlug.get(b.link.value) : undefined;
      return {
        key: b.id,
        title: pick(lang, b.titleAr, b.titleEn),
        subtitle: pick(lang, b.subtitleAr, b.subtitleEn),
        eyebrow: p ? pick(lang, p.nameAr, p.nameEn) : b.link?.type === "category" ? catName(b.link.value) : undefined,
        cta: pick(lang, b.ctaAr, b.ctaEn) || (b.link ? t("shopNow") : ""),
        picture: b.imageUrl,
        art: p ? { name: p.nameEn, imageUrl: p.imageUrl } : null,
        look: b.look ?? fallback,
        style: b.style,
        go: openLink(b.link),
        ...deal(p),
      };
    });
  }
  const featured = data.products.filter((p) => p.featured);
  const picks = (featured.length ? featured : [...data.products].sort((a, b) => b.packages - a.packages)).slice(0, 6);
  const styles: Banner["style"][] = ["dark", "accent", "light"];
  return picks.map((p, i) => ({
    key: p.id,
    title: pick(lang, p.nameAr, p.nameEn),
    eyebrow: catName(p.category),
    subtitle: `${t(`kind_${p.kind}`)} · ${t("instant")}`,
    cta: t("buyNow"),
    art: { name: p.nameEn, imageUrl: p.imageUrl },
    look: fallback,
    style: styles[i % styles.length]!,
    go: () => navigate(`/p/${p.slug}`),
    ...deal(p),
  }));
}

function HomeShowcase({ data }: { data: Catalog }) {
  return <Showcase slides={useSlides(data)} options={data.showcase} />;
}

// ───────────────────────────── shelves and grids

function Shelf({ title, icon, products, more, count }: { title: string; icon: ReactNode; products: ProductCard[]; more?: string; count?: number }) {
  const { t } = useT();
  const row = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => {
    const el = row.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    el.scrollBy({ left: dir * (rtl ? -1 : 1) * el.clientWidth * 0.85, behavior: "smooth" });
  };
  if (products.length === 0) return null;
  return (
    <section className="shelf">
      <div className="shelf__head">
        <h2>
          <span className="shelf__icon">{icon}</span>
          {title}
          {count !== undefined && <span className="shelf__count num">{count}</span>}
        </h2>
        <div className="shelf__tools">
          {products.length > 5 && (
            <>
          <button type="button" className="shelf__nav press" onClick={() => scroll(-1)} aria-label={t("previous")}>
            {/* ChevronIcon points forward in both directions; mirrored here for "previous". */}
            <span className="mirror">
              <ChevronIcon size={16} />
            </span>
          </button>
          <button type="button" className="shelf__nav press" onClick={() => scroll(1)} aria-label={t("next")}>
            <ChevronIcon size={16} />
          </button>
            </>
          )}
          {more && (
            <a className="shelf__more" href={more} onClick={linkHandler(more)}>
              {t("seeAll")}
            </a>
          )}
        </div>
      </div>
      <div className="shelf__row" ref={row}>
        {products.map((p) => (
          <ProductTile key={p.id} p={p} />
        ))}
      </div>
    </section>
  );
}

function CategoryPage({ slug, category, products }: { slug: string; category?: Category; products: ProductCard[] }) {
  const { t, lang } = useT();
  const items = products.filter((p) => p.category === slug);
  return (
    <>
      <div className="catpage__head">
        <button type="button" className="round-btn press" onClick={() => back("/")} aria-label={t("back")}>
          <span className="mirror">
            <ChevronIcon />
          </span>
        </button>
        <span className="catpage__icon">
          <CategoryIcon name={category?.icon} size={24} />
        </span>
        <div className="stack-sm" style={{ gap: 0 }}>
          <h1>{category ? pick(lang, category.nameAr, category.nameEn) : t("store")}</h1>
          <span className="small muted">{items.length === 1 ? t("productsOne") : t("productsCount", { n: items.length })}</span>
        </div>
      </div>
      {items.length === 0 ? <Empty>{t("noProducts")}</Empty> : <Grid products={items} />}
    </>
  );
}

function Results({ products }: { products: ProductCard[] }) {
  const { t } = useT();
  return (
    <>
      <div className="row-between">
        <h2>{t("results")}</h2>
        <span className="small muted">{products.length === 1 ? t("productsOne") : t("productsCount", { n: products.length })}</span>
      </div>
      {products.length === 0 ? <Empty>{t("noProducts")}</Empty> : <Grid products={products} />}
    </>
  );
}

function Grid({ products }: { products: ProductCard[] }) {
  return (
    <div className="grid">
      {products.map((p) => (
        <ProductTile key={p.id} p={p} />
      ))}
    </div>
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
          <span className="product__price">
            <span className="small">{t("from")}</span>
            <Money cents={p.fromCents} />
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
