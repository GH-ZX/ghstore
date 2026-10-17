/**
 * The home page's showcase (carousel). Each slide has a look (its own, or the
 * store's default from Admin → Home):
 *
 * - "cinematic": a poster. A big picture (a game's cover photo, or a banner's
 *   own picture) fills the slide; a small one (a game icon) becomes a large card
 *   over a blurred wash of its own colours.
 * - "deal": a slide that sells: the product's card and a few of its packages
 *   with prices as small glass buttons (one tap opens that package).
 *
 * A strip of the slides' pictures sits under the slides (over their corner on
 * wide screens); the active one fills while it shows, and when it is full the
 * next slide comes. Hovering, touching or focusing pauses it; reduced motion
 * and "autoplay off" stop it. Admin → Home previews with ShowcaseSlide, so the
 * preview is exactly what the store shows.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { pictureSrcSet, pictureUrl, SLIDE_PICTURE } from "@store/core";
import { usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { useApp, useT } from "../lib/state";
import { usePageLoaded } from "../lib/visible";
import type { Banner } from "../lib/types";
import { ArrowIcon, BoltIcon } from "./icons";
import { Tile } from "./kit";

export type ShowcaseStyle = "cinematic" | "deal";
/** Which of a product's pictures a slide shows: its wide cover, its square icon, or auto. */
export type PictureMode = "auto" | "wide" | "square";

/** Settings from Admin → Home (see app.settings home.*). */
export interface ShowcaseOptions {
  badgeInstant: boolean;
  badgeLabel: boolean;
  /** Seconds per slide; 0 = no autoplay. */
  autoplay: number;
  /** Which picture slides show unless they pick their own. */
  pictureMode?: PictureMode;
}

export const DEFAULT_OPTIONS: ShowcaseOptions = { badgeInstant: true, badgeLabel: true, autoplay: 6, pictureMode: "auto" };

export interface SlidePackage {
  id: string;
  nameAr: string;
  nameEn: string;
  priceCents: number;
}

export interface SlideData {
  key: string;
  look: ShowcaseStyle;
  title: string;
  subtitle?: ReactNode;
  /** A small line above the title: the product, or its category. */
  eyebrow?: string;
  cta?: string;
  /** The banner's own picture: always fills the slide. */
  picture?: string | null;
  /** The product's picture: fills the slide when it is big and wide, else a card. */
  art?: { name: string; imageUrl: string | null } | null;
  /** The product's wide cover picture, when it has one. */
  cover?: string | null;
  /** A category's products: shown as a grid of app icons when the slide has no picture of its own. */
  logos?: { name: string; imageUrl: string | null }[];
  /** The slide's own choice of picture; null follows the store's setting. */
  pictureMode?: PictureMode | null;
  style: Banner["style"];
  /** A few of the product's packages ("deal"), each opening that package. */
  packages?: SlidePackage[];
  /** How many packages the product has in all. */
  packageCount?: number;
  go?: (() => void) | null;
  goPackage?: ((id: string) => void) | null;
}

// ───────────────────────────── picture shape

/** A picture this wide and this big fills the slide; smaller ones are shown as a card. */
const COVER_MIN_WIDTH = 900;
const COVER_MIN_RATIO = 1.3;
const shapes = new Map<string, "cover" | "card">();

/**
 * "cover" for a big wide picture (a game's cover photo), "card" for an icon,
 * "unknown" while the picture is still loading (the slide then shows only its
 * colours, rather than guess and jump).
 */
export function usePictureShape(url: string | null | undefined): "cover" | "card" | "unknown" {
  const [shape, setShape] = useState<"cover" | "card" | "unknown">(() => (url ? shapes.get(url) ?? "unknown" : "card"));
  useEffect(() => {
    if (!url) return setShape("card");
    const known = shapes.get(url);
    if (known) return setShape(known);
    setShape("unknown");
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    // Measured on a copy at most 1000 px wide (never enlarged), not the full-size upload.
    const measured = pictureUrl(url, { width: 1000 });
    img.onload = () => {
      const s = img.naturalWidth >= COVER_MIN_WIDTH && img.naturalWidth / Math.max(1, img.naturalHeight) >= COVER_MIN_RATIO ? "cover" : "card";
      shapes.set(url, s);
      setShape(s);
    };
    img.onerror = () => {
      // The resized copy failed: measure the original.
      if (img.src !== url && measured !== url) {
        img.src = url;
        return;
      }
      shapes.set(url, "card");
      setShape("card");
    };
    img.src = measured;
  }, [url]);
  return shape;
}

/**
 * The slide's big picture at the size of the slide (phones and wide screens crop
 * it differently), the same addresses the Worker preloads for the first slide
 * (packages/api seo.ts). Falls back to the original when the resized one fails.
 */
function SlideCover({ url, first }: { url: string; first: boolean }) {
  const { config } = useApp();
  const [plain, setPlain] = useState(false);
  const opts = { cloudflare: config?.images?.resize };
  const phone = plain ? "" : pictureSrcSet(url, SLIDE_PICTURE.phone.widths, { ...opts, ratio: SLIDE_PICTURE.phone.ratio });
  const wide = plain ? "" : pictureSrcSet(url, SLIDE_PICTURE.wide.widths, { ...opts, ratio: SLIDE_PICTURE.wide.ratio });
  const img = (
    <img
      className="slide__cover"
      src={phone ? pictureUrl(url, { width: SLIDE_PICTURE.phone.widths[1], height: SLIDE_PICTURE.phone.widths[1] / SLIDE_PICTURE.phone.ratio }, opts) : url}
      srcSet={phone || undefined}
      sizes={phone ? SLIDE_PICTURE.phone.sizes : undefined}
      alt=""
      loading={first ? "eager" : "lazy"}
      fetchPriority={first ? "high" : undefined}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => !plain && phone && setPlain(true)}
    />
  );
  if (!wide) return img;
  return (
    <picture>
      <source media={SLIDE_PICTURE.wide.media} srcSet={wide} sizes={SLIDE_PICTURE.wide.sizes} />
      {img}
    </picture>
  );
}

// ───────────────────────────── one slide

export function ShowcaseSlide({ s, options = DEFAULT_OPTIONS, index = 0, count = 1, preview = false }: { s: SlideData; options?: ShowcaseOptions; index?: number; count?: number; preview?: boolean }) {
  const { t, lang } = useT();
  // Square: always the icon as a card. Wide or auto: the product's cover when it has
  // one, else its picture fills the slide when it is big and wide enough.
  const mode: PictureMode = s.pictureMode ?? options.pictureMode ?? "auto";
  const productCover = mode !== "square" && s.cover ? s.cover : null;
  // The slides after the first get their pictures once the page has loaded, so the first screen's come first.
  const loaded = usePageLoaded();
  const later = index > 0 && !preview && !loaded;
  const artShape = usePictureShape(later || s.picture || productCover || mode === "square" ? null : s.art?.imageUrl);
  // The picture that fills the slide: the banner's own, the product's cover, or its picture when it is a cover photo.
  const cover = later ? null : s.picture || productCover || (s.art?.imageUrl && artShape === "cover" ? s.art.imageUrl : null);
  const card = !later && !cover && s.art && artShape !== "unknown" ? s.art : null;
  // Still measuring the product's picture: its blurred colours only, for a moment.
  const wash = later ? null : card?.imageUrl ?? (artShape === "unknown" && !s.picture ? s.art?.imageUrl : null);
  const deal = s.look === "deal";
  const packages = deal ? s.packages ?? [] : [];
  // A category's slide without a picture: its apps' icons, two by two.
  const logos = !later && !cover && !card && !wash ? (s.logos ?? []).slice(0, 4) : [];
  const cls = [
    "slide", `slide--${s.look}`, `slide--${s.style}`, cover ? "slide--cover" : card || wash ? "slide--card" : "slide--plain",
    logos.length ? "slide--logos" : "", preview ? "slide--preview" : "",
  ].join(" ");

  const cta = s.cta && (s.go || preview) && (
    <span className="slide__cta" aria-hidden="true">
      {s.cta}
      <span className="flip-rtl">
        <ArrowIcon size={14} />
      </span>
    </span>
  );
  const badges = (deal && options.badgeInstant) || (options.badgeLabel && s.eyebrow);

  return (
    <div data-i={index} className={cls} role="group" aria-roledescription="slide" aria-label={`${index + 1} / ${count}`}>
      {cover && <SlideCover key={cover} url={cover} first={index === 0 && !preview} />}
      {/* Blurred to colours: a small copy is enough. */}
      {wash && <img className="slide__wash" src={pictureUrl(wash, { width: 160 })} alt="" aria-hidden="true" loading="lazy" decoding="async" referrerPolicy="no-referrer" />}
      {s.go && !preview && <button type="button" className="slide__hit" onClick={s.go} aria-label={s.cta ? `${s.title}: ${s.cta}` : s.title} />}

      {card && <Tile className="slide__art" name={card.name} imageUrl={card.imageUrl} width={520} eager={index === 0} />}
      {logos.length > 0 && (
        <div className={`slide__logos slide__logos--${logos.length}`} aria-hidden="true">
          {logos.map((l, i) => (
            <Tile key={i} className="slide__logo" name={l.name} imageUrl={l.imageUrl} width={200} eager={index === 0} />
          ))}
        </div>
      )}
      <div className="slide__text">
        {badges && (
          <div className="slide__badges">
            {deal && options.badgeInstant && (
              <span>
                <BoltIcon size={11} /> {t("instant")}
              </span>
            )}
            {options.badgeLabel && s.eyebrow && <span>{s.eyebrow}</span>}
          </div>
        )}
        <h2 className="slide__title">{s.title}</h2>
        {s.subtitle && <p className="slide__sub">{s.subtitle}</p>}
        {packages.length > 0 ? (
          <div className="slide__packages">
            {packages.map((p) => (
              <button key={p.id} type="button" className="slide__pkg press" tabIndex={preview ? -1 : undefined} onClick={() => !preview && (s.goPackage ? s.goPackage(p.id) : s.go?.())}>
                <bdi>{pick(lang, p.nameAr, p.nameEn)}</bdi>
                <span className="num">{usd(p.priceCents)}</span>
              </button>
            ))}
            <button type="button" className="slide__pkg slide__pkg--all press" tabIndex={preview ? -1 : undefined} onClick={() => !preview && s.go?.()}>
              {t("allPackages")}
              {s.packageCount ? <span className="num">{s.packageCount}</span> : null}
              <span className="flip-rtl">
                <ArrowIcon size={13} />
              </span>
            </button>
          </div>
        ) : (
          cta && <div className="slide__actions">{cta}</div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── the showcase

const PAUSE_AFTER_TOUCH_MS = 8000;

export function Showcase({ slides, options = DEFAULT_OPTIONS }: { slides: SlideData[]; options?: ShowcaseOptions }) {
  const { t } = useT();
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  // The visitor's own pause (the button), kept until they press play.
  const [paused, setPaused] = useState(false);
  const [reducedMotion] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const count = slides.length;

  const goTo = (i: number) => {
    const el = track.current;
    const slide = el?.children[i] as HTMLElement | undefined;
    if (!el || !slide) return;
    // offsetLeft works the same way in both directions; the browser maps it in RTL.
    el.scrollTo({ left: slide.offsetLeft - el.offsetLeft - (el.clientWidth - slide.clientWidth) / 2, behavior: "smooth" });
    setIndex(i);
  };

  /** The person is looking or swiping: hold autoplay for a while. */
  const hold = () => {
    setHeld(true);
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => setHeld(false), PAUSE_AFTER_TOUCH_MS);
  };
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  // Which slide is in view (swipes, the strip and autoplay alike).
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

  if (count === 0) return null;
  // Reduced motion stops autoplay (the progress never runs), so there is nothing to pause.
  const autoplay = options.autoplay > 0 && count > 1 && !reducedMotion;
  const next = () => goTo((index + 1) % count);

  return (
    <section
      className={`showcase showcase--${slides[index]?.look ?? "cinematic"}`}
      aria-roledescription="carousel"
      aria-label={t("highlights")}
      data-held={held || undefined}
      data-paused={paused || undefined}
      style={{ "--autoplay": `${options.autoplay || 6}s` } as CSSProperties}
    >
      {/* Moving slides are not read out as they change; chosen ones are. */}
      <div className="showcase__track" ref={track} onPointerDown={hold} onWheel={hold} onFocus={hold} aria-live={autoplay && !paused ? "off" : "polite"}>
        {slides.map((s, i) => (
          <ShowcaseSlide key={s.key} s={s} options={options} index={i} count={count} />
        ))}
      </div>

      {count > 1 && (
        <div className="showcase__thumbs" role="group" aria-label={t("highlights")}>
          {autoplay && (
            <button
              type="button"
              className="showcase__toggle press"
              aria-label={paused ? t("slidesPlay") : t("slidesPause")}
              title={paused ? t("slidesPlay") : t("slidesPause")}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" /></svg>
              )}
            </button>
          )}
          {slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className="showcase__thumb press"
              aria-current={i === index ? "true" : undefined}
              aria-label={t("slideOf", { n: i + 1, count, title: s.title })}
              onClick={() => {
                hold();
                goTo(i);
              }}
            >
              {s.picture ? (
                <img src={pictureUrl(s.picture, { width: 120, height: 120 })} width={50} height={50} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              ) : s.art ? (
                <Tile name={s.art.name} imageUrl={s.art.imageUrl} width={120} />
              ) : s.logos?.[0] ? (
                <Tile name={s.logos[0].name} imageUrl={s.logos[0].imageUrl} width={120} />
              ) : (
                <span className={`showcase__swatch showcase__swatch--${s.style}`} />
              )}
              {i === index && autoplay && (
                <span className="showcase__progress">
                  <span key={index} className="showcase__fill" onAnimationEnd={next} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
