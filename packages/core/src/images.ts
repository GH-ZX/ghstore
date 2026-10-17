/**
 * Smaller pictures. Product pictures uploaded in Admin live in the store's
 * Supabase Storage at their full size (often 1–2 MB); Supabase's image
 * transformations serve the same file at the size a screen needs, as WebP when
 * the browser takes it (https://supabase.com/docs/guides/storage/serving/image-transformations).
 * Pictures elsewhere are resized by Cloudflare when the owner switched that on
 * (Admin → Settings → Smaller pictures), else used as they are.
 *
 * The website (client) and the Worker (the page's <link rel="preload">) build
 * the same addresses with these functions, so a preloaded picture is the one the
 * page then shows.
 */

/** A public Supabase Storage object, in a format its image transformations handle. */
const SUPABASE_OBJECT = /^(https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1)\/object\/public\/([^?#]+\.(?:png|jpe?g|webp))$/i;

export interface PictureSize {
  width: number;
  /** With a height too, the picture is cropped to that box (like object-fit: cover). */
  height?: number;
}

export interface PictureOptions {
  /** Admin → Settings → Smaller pictures: Cloudflare resizes pictures hosted elsewhere. */
  cloudflare?: boolean;
}

/** The picture at about this size, or the address unchanged when it cannot be resized. */
export function pictureUrl(url: string, size: PictureSize, opts: PictureOptions = {}): string {
  const w = Math.max(16, Math.min(2500, Math.round(size.width)));
  const h = size.height ? Math.max(16, Math.min(2500, Math.round(size.height))) : null;
  const m = SUPABASE_OBJECT.exec(url);
  if (m) return `${m[1]}/render/image/public/${m[2]}?width=${w}${h ? `&height=${h}&resize=cover` : ""}&quality=75`;
  if (opts.cloudflare && /^https:\/\//.test(url) && !url.endsWith(".svg")) {
    return `/cdn-cgi/image/width=${w}${h ? `,height=${h},fit=cover` : ",fit=scale-down"},quality=80,format=auto/${url}`;
  }
  return url;
}

/** Can this picture be served smaller? */
export function canResize(url: string, opts: PictureOptions = {}): boolean {
  return pictureUrl(url, { width: 100 }, opts) !== url;
}

/**
 * A srcset for a picture shown in a box of this shape: each width, cropped to
 * the box's aspect ratio when one is given. Empty when it cannot be resized.
 */
export function pictureSrcSet(url: string, widths: readonly number[], opts: PictureOptions & { ratio?: number } = {}): string {
  if (!canResize(url, opts)) return "";
  return widths
    .map((w) => `${pictureUrl(url, { width: w, height: opts.ratio ? w / opts.ratio : undefined }, opts)} ${w}w`)
    .join(", ");
}

/**
 * The showcase's big picture (a banner's own picture or a game's cover), which
 * is usually the largest thing on the first screen. Phones show it in a box
 * about as tall as it is wide; wide screens in a long strip. Keep in step with
 * .slide in client/src/styles.css.
 */
export const SLIDE_PICTURE = {
  phone: { media: "(max-width: 799px)", widths: [480, 720, 960], ratio: 0.92, sizes: "calc(100vw - 66px)" },
  wide: { media: "(min-width: 800px)", widths: [1100, 1600, 2200], ratio: 3, sizes: "min(1120px, 100vw - 32px)" },
} as const;
