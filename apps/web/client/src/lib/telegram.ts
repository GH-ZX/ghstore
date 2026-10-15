/**
 * Telegram Mini App bridge. The script from telegram.org is loaded only when the
 * page was opened from Telegram, so website visitors never download it.
 * https://core.telegram.org/bots/webapps
 */

export interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string; language_code?: string } };
  colorScheme: "light" | "dark";
  platform: string;
  version: string;
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(v: string): boolean;
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  openInvoice(url: string, cb?: (status: "paid" | "cancelled" | "failed" | "pending") => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  disableVerticalSwipes?(): void;
  onEvent(event: string, cb: () => void): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

const FLAG = "gh.tg";

/** Opened from Telegram? (launch data in the URL, the /tg entry path, or earlier in this tab) */
export function isTelegramLaunch(): boolean {
  if (location.hash.includes("tgWebAppData") || location.pathname === "/tg" || location.pathname.startsWith("/tg/")) return true;
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

let webApp: TgWebApp | null = null;

export function tg(): TgWebApp | null {
  return webApp;
}

export async function loadTelegram(): Promise<TgWebApp | null> {
  if (!isTelegramLaunch()) return null;
  if (!window.Telegram?.WebApp) {
    await new Promise<void>((resolve) => {
      const s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-web-app.js?59";
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }
  const w = window.Telegram?.WebApp;
  if (!w || !w.initData) return null;
  try {
    sessionStorage.setItem(FLAG, "1");
  } catch {
    /* ignore */
  }
  webApp = w;
  w.ready();
  w.expand();
  w.disableVerticalSwipes?.();
  return w;
}

/** Match Telegram's own bars to the page background. */
export function paintTelegram(bg: string): void {
  if (!webApp) return;
  try {
    webApp.setHeaderColor?.(bg);
    webApp.setBackgroundColor?.(bg);
    webApp.setBottomBarColor?.(bg);
  } catch {
    /* older clients */
  }
}

export function haptic(kind: "tap" | "success" | "error" = "tap"): void {
  const h = webApp?.HapticFeedback;
  if (!h) return;
  if (kind === "tap") h.impactOccurred("light");
  else h.notificationOccurred(kind);
}

/** Open an external payment page: inside Telegram through its browser, else a new tab. */
export function openExternal(url: string): void {
  if (webApp) webApp.openLink(url);
  else window.open(url, "_blank", "noopener");
}

/** Open a t.me link: inside Telegram without leaving the app, else a new tab. */
export function openTelegramLink(url: string): void {
  if (webApp) webApp.openTelegramLink(url);
  else window.open(url, "_blank", "noopener");
}

/**
 * Telegram's back button, shared by pages and sheets: the newest handler wins,
 * and the button hides when nothing needs it.
 */
const backStack: (() => void)[] = [];
let backInstalled = false;

export function pushBack(fn: () => void): () => void {
  const w = webApp;
  if (!w) return () => {};
  if (!backInstalled) {
    w.BackButton.onClick(() => backStack[backStack.length - 1]?.());
    backInstalled = true;
  }
  backStack.push(fn);
  w.BackButton.show();
  return () => {
    const i = backStack.lastIndexOf(fn);
    if (i >= 0) backStack.splice(i, 1);
    if (!backStack.length) w.BackButton.hide();
  };
}
