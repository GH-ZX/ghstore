/**
 * Store home: search, the banner carousel, the category bar, then one shelf per
 * category ("See all" opens the category's own page at /c/:slug). Typing in
 * search swaps everything below it for the matching products.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { matchesQuery } from "@store/core";
import { usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { back, linkHandler, match, navigate, usePath } from "../lib/router";
import { useT } from "../lib/state";
import { openExternal } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import type { Banner, Category, ProductCard } from "../lib/types";
import { ArrowIcon, BoltIcon, CategoryIcon, ChevronIcon, SearchIcon } from "../ui/icons";
import { Empty, ErrorBox, Money, PageLoading, Tile } from "../ui/kit";
import { Shell } from "../ui/Shell";
import { ProductSheet } from "./ProductSheet";

interface Catalog {
  categories: Category[];
  products: ProductCard[];
  banners?: Banner[];
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
      <Carousel banners={banners} featured={featured} />

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

// ───────────────────────────── carousel

interface Slide {
  key: string;
  title: string;
  subtitle: ReactNode;
  cta: string;
  imageUrl: string | null;
  style: Banner["style"];
  /** A product picture shown beside the text (featured slides). */
  art?: { name: string; imageUrl: string | null };
  go: (() => void) | null;
}

function openLink(link: Banner["link"]): (() => void) | null {
  if (!link) return null;
  if (link.type === "product") return () => navigate(`/p/${link.value}`);
  if (link.type === "category") return () => navigate(`/c/${link.value}`);
  if (link.value.startsWith("/")) return () => navigate(link.value);
  return () => openExternal(link.value);
}

const AUTO_MS = 5500;

function Carousel({ banners, featured }: { banners: Banner[]; featured: ProductCard[] }) {
  const { t, lang } = useT();
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const touched = useRef(0);

  // Banners from Admin → Home; until there are some, the featured products.
  const slides: Slide[] = banners.length
    ? banners.map((b) => ({
        key: b.id,
        title: pick(lang, b.titleAr, b.titleEn),
        subtitle: pick(lang, b.subtitleAr, b.subtitleEn),
        cta: pick(lang, b.ctaAr, b.ctaEn) || (b.link ? t("shopNow") : ""),
        imageUrl: b.imageUrl,
        style: b.style,
        go: openLink(b.link),
      }))
    : featured.slice(0, 6).map((p) => ({
        key: p.id,
        title: pick(lang, p.nameAr, p.nameEn),
        subtitle: (
          <>
            {t("from")} <span className="num">{usd(p.fromCents)}</span>
          </>
        ),
        cta: t("buyNow"),
        imageUrl: null,
        style: "accent" as const,
        art: { name: p.nameEn, imageUrl: p.imageUrl },
        go: () => navigate(`/p/${p.slug}`),
      }));

  const count = slides.length;
  const goTo = (i: number) => {
    const el = track.current;
    const slide = el?.children[i] as HTMLElement | undefined;
    if (!el || !slide) return;
    // offsetLeft works the same way in both directions; the browser maps it in RTL.
    el.scrollTo({ left: slide.offsetLeft - el.offsetLeft - (el.clientWidth - slide.clientWidth) / 2, behavior: "smooth" });
  };

  // Which slide is in view (works for swipes, dots and autoplay alike).
  useEffect(() => {
    const el = track.current;
    if (!el || count < 2) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.6) setIndex(Number((e.target as HTMLElement).dataset.i));
      },
      { root: el, threshold: [0.6] },
    );
    for (const child of Array.from(el.children)) io.observe(child);
    return () => io.disconnect();
  }, [count]);

  // Autoplay, paused for a while after the person swipes or taps, and off for reduced motion.
  useEffect(() => {
    if (count < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => {
      if (document.hidden || Date.now() - touched.current < 8000) return;
      goTo((index + 1) % count);
    }, AUTO_MS);
    return () => clearInterval(id);
  }, [index, count]);

  if (count === 0) return null;
  return (
    <section className="carousel" aria-roledescription="carousel" aria-label={t("highlights")}>
      <div
        className="carousel__track"
        ref={track}
        onPointerDown={() => (touched.current = Date.now())}
        onWheel={() => (touched.current = Date.now())}
        onFocus={() => (touched.current = Date.now())}
      >
        {slides.map((s, i) => (
          <div
            key={s.key}
            data-i={i}
            className={`slide slide--${s.style}${s.imageUrl ? " slide--image" : ""}`}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} / ${count}`}
          >
            {s.imageUrl && <img className="slide__bg" src={s.imageUrl} alt="" loading={i === 0 ? "eager" : "lazy"} decoding="async" />}
            <div className="slide__text">
              <h2 className="slide__title">{s.title}</h2>
              {s.subtitle && <p className="slide__sub">{s.subtitle}</p>}
              {s.go && s.cta && (
                <button type="button" className="slide__cta press" onClick={s.go}>
                  {s.cta}
                  <span className="flip-rtl" aria-hidden="true">
                    <ArrowIcon size={16} />
                  </span>
                </button>
              )}
            </div>
            {s.art && <Tile className="slide__art" name={s.art.name} imageUrl={s.art.imageUrl} />}
            {s.go && !s.cta && <button type="button" className="slide__hit" onClick={s.go} aria-label={s.title} />}
          </div>
        ))}
      </div>
      {count > 1 && (
        <div className="carousel__dots">
          {slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-label={`${i + 1}`}
              aria-current={i === index ? "true" : undefined}
              onClick={() => {
                touched.current = Date.now();
                goTo(i);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
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
