/**
 * A product's picture box: the one look every product has, everywhere it is
 * shown (store cards, the product sheet, search, favourites, orders, the
 * showcase). The box keeps the size its place gives it (CSS); inside it:
 *
 * - the owner's picture (Admin → Catalogue) always comes first:
 *   - a roughly square one (an app logo) is shown whole, at one size, with
 *     rounded corners, over a blurred and darkened copy of itself: never cropped;
 *   - a wide one (cover art) fills the box;
 *   - an SVG mark or site icon sits on a light plate (marks are drawn for light
 *     backgrounds), and simple-icons' own files become the store's brand mark.
 * - no picture: the brand's mark in its colour, when the name starts with a
 *   brand the store carries (packages/core art.ts, /brands/<slug>.svg);
 * - else the product's name, set as a title on a colour of its own (the same
 *   for the same name, everywhere).
 *
 * The shape is measured when the picture loads (and remembered), so a picture
 * never jumps from cropped to whole. Pictures load when they come near the
 * screen (lib/visible.ts) at about the size they are shown (packages/core
 * images.ts); `width` is about twice the shown width, for sharp screens.
 */
import { useRef, useState, type CSSProperties } from "react";
import { artName, brandFor, brandFromIconUrl, brandInk, pictureUrl, type Brand } from "@store/core";
import { hashText } from "../lib/format";
import { useApp } from "../lib/state";
import { useNear } from "../lib/visible";

/** SVG marks and site icons: whole, on a light plate. */
const PLATE_URL = /simpleicons|favicons|\.svg(\?|$)/i;
/** Pictures this close to square are logos: shown whole, never cropped. */
const LOGO_MIN = 0.75;
const LOGO_MAX = 1.35;

type Shape = "logo" | "cover";
const shapes = new Map<string, Shape>();

/** What the box shows, before any picture loads. */
export type ArtKind = "picture" | "brand" | "name";

/** What a product's box will show (the admin's preview says it in words). */
export function artKind(name: string, imageUrl?: string | null): ArtKind {
  if (imageUrl?.trim()) return brandFromIconUrl(imageUrl) ? "brand" : "picture";
  return brandFor(name) ? "brand" : "name";
}

export interface ProductArtProps {
  /** The product's English name (its colour and brand come from it). */
  name: string;
  /** Its Arabic name, for the name tile when there is no English one. */
  nameAr?: string;
  imageUrl?: string | null;
  /** A wide cover picture, tried first (the product sheet's banner). */
  coverUrl?: string | null;
  className?: string;
  width?: number;
  /** A picture on the first screen: loads at once. */
  eager?: boolean;
}

export function ProductArt({ name, nameAr, imageUrl, coverUrl, className, width = 400, eager = false }: ProductArtProps) {
  const { config } = useApp();
  const box = useRef<HTMLSpanElement>(null);
  // Pictures that failed (each falls back to the next, then to the mark or name).
  const [broken, setBroken] = useState<readonly string[]>([]);
  const [plain, setPlain] = useState<readonly string[]>([]);
  const [, setMeasured] = useState(0);
  const url = [coverUrl, imageUrl].map((u) => u?.trim()).find((u): u is string => !!u && !broken.includes(u)) ?? null;
  const near = useNear(box, eager, url);
  const cls = (kind: string) => `art art--${kind} ${className ?? ""}`;

  const iconBrand = url ? brandFromIconUrl(url) : null;
  if (!url || iconBrand) {
    const brand = iconBrand ?? brandFor(name);
    const text = name.trim() || nameAr?.trim() || "";
    if (brand) return <BrandArt brand={brand} name={text} className={cls("brand")} />;
    return <NameArt name={text} seed={name || text} className={cls("name")} />;
  }

  const plate = PLATE_URL.test(url);
  const small = !plate && !plain.includes(url) ? pictureUrl(url, { width }, { cloudflare: config?.images?.resize }) : url;
  const src = small !== url ? small : url;
  const shape: Shape | "loading" = plate ? "logo" : shapes.get(url) ?? "loading";
  const fail = () => (src !== url ? setPlain((p) => [...p, url]) : setBroken((b) => [...b, url]));
  const measure = (img: HTMLImageElement | null) => {
    // Only while this box still waits for the shape (another box may have measured it meanwhile).
    if (!img || !img.complete || !img.naturalWidth || plate || shape !== "loading") return;
    if (!shapes.has(url)) {
      const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
      shapes.set(url, ratio >= LOGO_MIN && ratio <= LOGO_MAX ? "logo" : "cover");
    }
    setMeasured((n) => n + 1);
  };
  const img = (cn: string, main: boolean) => (
    <img
      className={cn}
      src={src}
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      referrerPolicy="no-referrer"
      ref={main ? measure : undefined}
      onLoad={main ? (e) => measure(e.currentTarget) : undefined}
      onError={main ? fail : undefined}
    />
  );
  return (
    <span ref={box} className={`${cls(`pic`)} art--${shape}${plate ? " art--plate" : ""}`} aria-hidden="true">
      {near && shape === "logo" && !plate && img("art__blur", false)}
      {near && <span className="art__frame">{img("art__img", true)}</span>}
    </span>
  );
}

/** The brand's mark in its colour, with the product's name where the box has room. */
function BrandArt({ brand, name, className }: { brand: Brand; name: string; className: string }) {
  const { title, plan } = artName(name || brand.title);
  const style = { "--brand": `#${brand.hex}`, "--brand-ink": brandInk(brand.hex), "--mark": `url("/brands/${brand.slug}.svg")` } as CSSProperties;
  return (
    <span className={className} style={style} aria-hidden="true">
      <span className="art__in">
        <span className="art__mark" />
        <span className="art__label">
          <span className="art__label-name" dir="auto">{title}</span>
          {plan && <span className="art__plan" dir="auto">{plan}</span>}
        </span>
      </span>
    </span>
  );
}

/** Hues for the name tile: violet, magenta, rose, coral, amber, emerald, teal, blue. */
const HUES = [285, 320, 355, 25, 60, 155, 195, 250];

/**
 * The name, split over at most two lines at a space (never inside a word), and
 * how many letters the longest line has: the CSS sizes the type from that so it
 * fills the box (--fit) without being cut.
 */
export function titleLines(title: string): { lines: string[]; fit: number } {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 2 || title.length <= 9) return { lines: [title], fit: Math.max(3, title.length) };
  let best = { lines: [title], fit: title.length };
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const fit = Math.max(a.length, b.length);
    if (fit < best.fit) best = { lines: [a, b], fit };
  }
  return { lines: best.lines, fit: Math.max(3, best.fit) };
}

/** The product's name as its title, on a colour of its own. */
function NameArt({ name, seed, className }: { name: string; seed: string; className: string }) {
  const { title, plan } = artName(name);
  const { lines, fit } = titleLines(title);
  const style = { "--h": HUES[hashText(seed) % HUES.length], "--fit": fit, "--lines": lines.length } as CSSProperties;
  return (
    <span className={className} style={style} aria-hidden="true">
      <span className="art__in">
        <span className="art__title" dir="auto">
          {lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </span>
        {plan && <span className="art__plan" dir="auto">{plan}</span>}
      </span>
    </span>
  );
}
