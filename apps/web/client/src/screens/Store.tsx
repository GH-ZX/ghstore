/**
 * Store home: the showcase (ui/Showcase.tsx), the category bar, then one shelf per
 * category ("See all" opens the category's own page at /c/:slug). Search lives in
 * the header (ui/Search.tsx).
 */
import { useMemo, useRef, type ReactNode } from "react";
import { hashText } from "../lib/format";
import { pick } from "../lib/i18n";
import { back, linkHandler, match, navigate, usePath } from "../lib/router";
import { useT } from "../lib/state";
import { openExternal } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import type { Banner, Category, ProductCard } from "../lib/types";
import { BoltIcon, CategoryIcon, ChevronIcon } from "../ui/icons";
import { Empty, ErrorBox, Money, PageLoading } from "../ui/kit";
import { ProductArt } from "../ui/ProductArt";
import { Shell } from "../ui/Shell";
import { Showcase, type ShowcaseOptions, type ShowcaseStyle, type SlideData, type SlidePackage } from "../ui/Showcase";
import { SiteFooter } from "../ui/Footer";

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
  const catPage = match("/c/:slug", path);
  const { data, error, loading, reload } = useApi<Catalog>("/api/catalog");

  const categories = useMemo(() => {
    const present = new Set((data?.products ?? []).map((p) => p.category));
    return (data?.categories ?? []).filter((c) => present.has(c.slug));
  }, [data]);

  const category = catPage ? (data?.categories ?? []).find((c) => c.slug === catPage.slug) : undefined;
  const title = category ? pick(lang, category.nameAr, category.nameEn) : t("store");

  return (
    <Shell title={title}>
      <div className="stack screen home" key={catPage?.slug ?? "home"}>
        {loading && !data && <PageLoading />}
        <ErrorBox error={data ? null : error} onRetry={reload} />

        {data && catPage && <CategoryPage slug={catPage.slug!} category={category} products={data.products} />}
        {data && !catPage && <Home data={data} categories={categories} />}
        {data && <SiteFooter />}
      </div>
    </Shell>
  );
}

/**
 * Today's picks: the owner's featured products first, then, to fill the row on
 * a wide screen, best sellers, hot and new products, then the rest, in an order
 * that changes once a day.
 */
function todaysPicks(products: ProductCard[], max = 12): ProductCard[] {
  const featured = products.filter((p) => p.featured);
  const day = new Date().toISOString().slice(0, 10);
  const rank = (p: ProductCard) => (p.badge === "best" ? 0 : p.badge === "hot" ? 1 : p.badge === "new" ? 2 : 3);
  const rest = products
    .filter((p) => !p.featured)
    // Shuffled the same way all day.
    .map((p) => ({ p, r: rank(p), h: hashText(`${day}:${p.id}`) }))
    .sort((a, b) => a.r - b.r || a.h - b.h)
    .map((x) => x.p);
  return [...featured, ...rest].slice(0, Math.max(max, featured.length));
}

function Home({ data, categories }: { data: Catalog; categories: Category[] }) {
  const { t, lang } = useT();
  const picks = useMemo(() => todaysPicks(data.products), [data.products]);
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

      {banners.length > 0 && picks.length > 0 && <Shelf title={t("todaysPicks")} icon={<BoltIcon size={16} />} products={picks} />}

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
  const to = link.value.trim();
  // A page of this store ("/wallet"), never "//other.site" or "/\other.site".
  if (to.startsWith("/")) return to.startsWith("//") || to.includes("\\") ? null : () => navigate(to);
  // Anything else opens outside the store, and only over https.
  try {
    return new URL(to).protocol === "https:" ? () => openExternal(to) : null;
  } catch {
    return null;
  }
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
  // A category's slide shows its apps: the first products that have a picture.
  const logosOf = (slug: string) =>
    data.products
      .filter((p) => p.category === slug)
      .sort((a, b) => Number(!!b.imageUrl) - Number(!!a.imageUrl))
      .slice(0, 4)
      .map((p) => ({ name: p.nameEn, imageUrl: p.imageUrl }));
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
        cover: p?.coverUrl ?? null,
        logos: b.link?.type === "category" ? logosOf(b.link.value) : undefined,
        pictureMode: b.pictureMode ?? null,
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
    subtitle: p.badge ? `${t(`kind_${p.kind}`)} · ${t(`badge_${p.badge}`)}` : t(`kind_${p.kind}`),
    cta: t("buyNow"),
    art: { name: p.nameEn, imageUrl: p.imageUrl },
    cover: p.coverUrl ?? null,
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
        <ProductArt name={p.nameEn} nameAr={p.nameAr} imageUrl={p.imageUrl} />
        <span className="product__body">
          <span className="product__name">{name}</span>
          <span className="product__price">
            <span className="small">{t("from")}</span>
            <Money cents={p.fromCents} />
            {p.rating && p.rating.count > 0 && (
              <span className="product__rating" aria-label={t("starsLabel", { n: p.rating.average })}>
                ★ <span className="num">{p.rating.average.toFixed(1)}</span>
              </span>
            )}
          </span>
        </span>
      </a>
      {/* Only the badge the owner chose for this product (Admin → Catalogue). */}
      {p.badge && (
        <span className={`product__flag product__flag--${p.badge}`} aria-hidden="true">
          {p.badge === "instant" ? <BoltIcon /> : null}
          {t(`badge_${p.badge}`)}
        </span>
      )}
    </div>
  );
}
