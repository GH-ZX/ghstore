/**
 * A small history router: enough for this app's handful of pages without a
 * routing library. Paths are matched with ":param" segments.
 */
import { useSyncExternalStore, type MouseEvent } from "react";

const listeners = new Set<() => void>();
let path = normalise(location.pathname);
let search = location.search;
/** How many in-app pages are behind us, so "back" never leaves the app. */
let depth = 0;

/**
 * Screens and overlays. A product (/p/<slug>) opens as a sheet *over* the
 * screen you were on: the address changes (so it can be shared and Back closes
 * it), but the screen underneath stays mounted, with its scroll, search and
 * filters. `under` is that screen's address, kept in the history entry; a
 * product opened from a link (nothing underneath) shows over the home page.
 */
export function isOverlay(p: string): boolean {
  return p.startsWith("/p/");
}

interface Entry {
  under?: string | null;
}

const readUnder = (): string | null => {
  const u = (history.state as Entry | null)?.under;
  return typeof u === "string" && u.startsWith("/") && !u.startsWith("//") ? u : null;
};

let under: string | null = isOverlay(path) ? readUnder() : null;
let screen = computeScreen();

function computeScreen(): { path: string; search: string } {
  if (!isOverlay(path)) return { path, search };
  if (!under) return { path: "/", search: "" };
  const u = new URL(under, location.origin);
  return { path: normalise(u.pathname), search: u.search };
}

function normalise(p: string): string {
  // The Mini App opens at /tg; inside, it uses the same routes as the website.
  if (p === "/tg" || p.startsWith("/tg/")) p = p.slice(3) || "/";
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

// Keep the hash: Telegram passes the Mini App launch data there (#tgWebAppData=…).
if (normalise(location.pathname) !== location.pathname) {
  history.replaceState(null, "", path + location.search + location.hash);
}

function emit(): void {
  for (const l of listeners) l();
}

window.addEventListener("popstate", () => {
  depth = Math.max(0, depth - 1);
  path = normalise(location.pathname);
  search = location.search;
  under = isOverlay(path) ? readUnder() : null;
  screen = computeScreen();
  emit();
});

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  const next = normalise(url.pathname);
  if (next === path && url.search === search && !opts.replace) return;
  // Opening an overlay keeps the screen underneath (one product to the next keeps the same one).
  // A replaced screen (sign-in finishing, a deep link at start-up) is gone, so it is not kept underneath.
  const nextUnder = isOverlay(next) ? (isOverlay(path) ? under : opts.replace ? null : path + search) : null;
  const entry: Entry | null = nextUnder ? { under: nextUnder } : null;
  if (opts.replace) history.replaceState(entry, "", next + url.search);
  else {
    history.pushState(entry, "", next + url.search);
    depth++;
  }
  const prevScreen = screen;
  path = next;
  search = url.search;
  under = nextUnder;
  screen = computeScreen();
  emit();
  // A new screen starts at the top; an overlay leaves the screen under it where it was.
  if (!opts.replace && (screen.path !== prevScreen.path || screen.search !== prevScreen.search)) window.scrollTo({ top: 0 });
}

export function back(fallback = "/"): void {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

/** Close the overlay (a product): back to the screen under it, or home when it was opened from a link. */
export function closeOverlay(): void {
  if (depth > 0) history.back();
  else navigate(under ?? "/", { replace: true });
}

export function canGoBack(): boolean {
  return depth > 0;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The screen's path: under an open product, the screen it was opened from. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => screen.path, () => screen.path);
}

/** The screen's query string (an overlay's own query does not reach the screen under it). */
export function useQuery(): URLSearchParams {
  const s = useSyncExternalStore(subscribe, () => screen.search, () => screen.search);
  return new URLSearchParams(s);
}

/** The open overlay's path ("/p/<slug>"), or null. */
export function useOverlay(): string | null {
  return useSyncExternalStore(subscribe, () => (isOverlay(path) ? path : null), () => (isOverlay(path) ? path : null));
}

/** Match "/orders/:id" against "/orders/abc" → { id: "abc" }, or null. */
export function match(pattern: string, p: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = p.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(b[i]!);
    else if (seg !== b[i]) return null;
  }
  return params;
}

/** onClick for <a href>: client-side navigation, keeping new-tab clicks native. */
export function linkHandler(to: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
}
