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
  emit();
});

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  const next = normalise(url.pathname);
  if (next === path && url.search === search && !opts.replace) return;
  if (opts.replace) history.replaceState(null, "", next + url.search);
  else {
    history.pushState(null, "", next + url.search);
    depth++;
  }
  path = next;
  search = url.search;
  emit();
  if (!opts.replace) window.scrollTo({ top: 0 });
}

export function back(fallback = "/"): void {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function canGoBack(): boolean {
  return depth > 0;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => path, () => path);
}

export function useQuery(): URLSearchParams {
  const s = useSyncExternalStore(subscribe, () => search, () => search);
  return new URLSearchParams(s);
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
