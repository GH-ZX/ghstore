/**
 * App-wide state: config, the signed-in user, language, appearance and toasts.
 * A tiny store read with useSyncExternalStore; no state library needed.
 */
import { useSyncExternalStore } from "react";
import { googleFontsHref, isPreset, themeCss, THEMES } from "@store/ui";
import { store as storeConfig } from "@store/config";
import { api, setToken } from "./api";
import { translate, type MsgKey } from "./i18n";
import { paintTelegram, tg } from "./telegram";
import type { Lang, Me, PublicConfig } from "./types";

export type Mode = "system" | "light" | "dark";

export interface AppState {
  config: PublicConfig | null;
  me: Me | null;
  /** True once we know whether someone is signed in. */
  authChecked: boolean;
  lang: Lang;
  mode: Mode;
  miniApp: boolean;
  toast: { text: string; bad: boolean; id: number } | null;
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

let state: AppState = {
  config: null,
  me: null,
  authChecked: false,
  lang: readPref<Lang>("gh.lang", ["ar", "en"], storeConfig.defaultLocale),
  mode: readPref<Mode>("gh.mode", ["system", "light", "dark"], "system"),
  miniApp: false,
  toast: null,
};
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** Translation bound to the current language. */
export function useT(): { t: (key: MsgKey, vars?: Record<string, string | number>) => string; lang: Lang } {
  const { lang } = useApp();
  return { t: (key, vars) => translate(lang, key, vars), lang };
}

// ───────────────────────────── language and appearance

export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

export function setLang(lang: Lang): void {
  writePref("gh.lang", lang);
  applyLang(lang);
  setState({ lang });
  if (state.me) void api("/api/me", { method: "PATCH", body: { locale: lang } }).catch(() => {});
}

/** The colours actually showing, for painting Telegram's bars. */
function currentBg(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0B0A12";
}

export function applyTheme(): void {
  const root = document.documentElement;
  const cfg = state.config?.theme;
  const preset = cfg && isPreset(cfg.preset) ? cfg.preset : storeConfig.theme.preset;
  const defaultMode = cfg?.defaultMode ?? storeConfig.theme.mode;
  const styleEl = document.getElementById("theme");
  if (styleEl) styleEl.textContent = themeCss(preset, defaultMode);
  const fonts = document.getElementById("fonts") as HTMLLinkElement | null;
  const href = googleFontsHref(preset);
  if (fonts && fonts.getAttribute("href") !== href) fonts.setAttribute("href", href);
  // Visitor choice wins; in Telegram "auto" follows Telegram's own light/dark.
  let mode: Mode = state.mode;
  if (mode === "system" && state.miniApp && tg()) mode = tg()!.colorScheme;
  if (mode === "system") root.removeAttribute("data-mode");
  else root.setAttribute("data-mode", mode);
  const meta = document.querySelector('meta[name="theme-color"]') ?? document.head.appendChild(Object.assign(document.createElement("meta"), { name: "theme-color" }));
  const bg = currentBg();
  meta.setAttribute("content", bg);
  paintTelegram(bg);
}

export function setMode(mode: Mode): void {
  writePref("gh.mode", mode);
  setState({ mode });
  applyTheme();
}

export const PRESETS = Object.keys(THEMES) as (keyof typeof THEMES)[];

// ───────────────────────────── session

export async function refreshMe(): Promise<Me | null> {
  try {
    const me = await api<Me>("/api/me");
    setState({ me, authChecked: true });
    return me;
  } catch {
    setState({ me: null, authChecked: true });
    return null;
  }
}

export async function signOut(): Promise<void> {
  await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
  setToken(null);
  setState({ me: null });
}

// ───────────────────────────── toasts

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, bad = false): void {
  clearTimeout(toastTimer);
  setState({ toast: { text, bad, id: Date.now() } });
  toastTimer = setTimeout(() => setState({ toast: null }), 2600);
}
