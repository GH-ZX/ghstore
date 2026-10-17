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
  /** This history entry's own name, for its scroll position (see "Scroll" below). */
  key?: string;
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

// ───────────────────────────── scroll
//
// Each history entry remembers how far its screen was scrolled. Back (or
// Forward) to a screen puts it where it was once it has drawn (search → a
// category → Back lands on the search results where they were); a new screen
// starts at the top. The browser's own restoring is off: it would jump before
// the screen is there.

const SCROLL_KEY = "gh.scroll";
const newKey = () => Math.random().toString(36).slice(2, 10);
const scrolls = new Map<string, number>(
  (() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? "[]");
      return Array.isArray(v) ? (v.filter((x) => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "number") as [string, number][]) : [];
    } catch {
      return [];
    }
  })(),
);

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
let entryKey = (history.state as Entry | null)?.key ?? newKey();
if (!(history.state as Entry | null)?.key) history.replaceState({ ...((history.state as Entry | null) ?? {}), key: entryKey }, "", location.href);

/** Remember where the current entry's screen is scrolled (a reload keeps it for this tab). */
function saveScroll(): void {
  scrolls.set(entryKey, window.scrollY);
  // Keep the newest few hundred.
  while (scrolls.size > 200) scrolls.delete(scrolls.keys().next().value!);
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify([...scrolls]));
  } catch {
    /* storage can be unavailable */
  }
}

let restoring = 0;
/** Scroll to `y` once the screen is tall enough (its content may still be drawing), giving up after a while or when the person scrolls. */
function restoreScroll(y: number): void {
  const mine = ++restoring;
  const start = performance.now();
  let touched = false;
  const stop = () => (touched = true);
  const events = ["wheel", "touchstart", "keydown"] as const;
  for (const e of events) window.addEventListener(e, stop, { passive: true });
  const done = () => {
    for (const e of events) window.removeEventListener(e, stop);
  };
  // Timers rather than animation frames, which a background tab does not run.
  const step = () => {
    if (mine !== restoring || touched) return done();
    window.scrollTo({ top: y });
    const now = performance.now();
    // Held for a moment after reaching it: the screen may still be swapping in.
    if ((Math.abs(window.scrollY - y) < 2 && now - start > 150) || now - start > 1500) return done();
    window.setTimeout(step, 16);
  };
  window.setTimeout(step, 0);
}

// The position is kept when leaving the page too (a reload, a payment page and back).
window.addEventListener("pagehide", saveScroll);

function emit(): void {
  for (const l of listeners) l();
}

window.addEventListener("popstate", () => {
  // The entry we are leaving keeps its position (the browser has not scrolled: restoring is manual).
  saveScroll();
  depth = Math.max(0, depth - 1);
  const prevScreen = screen;
  path = normalise(location.pathname);
  search = location.search;
  under = isOverlay(path) ? readUnder() : null;
  screen = computeScreen();
  entryKey = (history.state as Entry | null)?.key ?? newKey();
  emit();
  // Back to another screen: where it was. Closing a product leaves the screen under it alone.
  if (screen.path !== prevScreen.path || screen.search !== prevScreen.search) restoreScroll(scrolls.get(entryKey) ?? 0);
});

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  const next = normalise(url.pathname);
  if (next === path && url.search === search && !opts.replace) return;
  // Opening an overlay keeps the screen underneath (one product to the next keeps the same one).
  // A replaced screen (sign-in finishing, a deep link at start-up) is gone, so it is not kept underneath.
  const nextUnder = isOverlay(next) ? (isOverlay(path) ? under : opts.replace ? null : path + search) : null;
  // A replaced entry keeps its name (and its place in the scroll memory); a new one gets its own.
  if (!opts.replace) {
    saveScroll();
    restoring++;
    entryKey = newKey();
  }
  const entry: Entry = { ...(nextUnder ? { under: nextUnder } : {}), key: entryKey };
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
