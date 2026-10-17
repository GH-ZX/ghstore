/**
 * Start-up: Telegram (when opened from the bot), store settings and theme,
 * sign-in, then render. The splash (index.html) covers the page until the user
 * and their balance are known, so "Sign in" never flashes for someone signed in.
 */
import { createRoot } from "react-dom/client";
import { api, hasToken, setToken } from "./lib/api";
import { captureReferralFromUrl, stashReferral } from "./lib/referral";
import { navigate } from "./lib/router";
import { prefetch } from "./lib/useApi";
import { applyLang, applyTheme, getState, refreshMe, setState } from "./lib/state";
import { isTelegramLaunch, loadTelegram, type TgWebApp } from "./lib/telegram";
import type { PublicConfig } from "./lib/types";
import { App } from "./App";
import { startAnalytics } from "./lib/analytics";

// The fonts' stylesheet loads without holding the first paint (index.html has it
// as media="print" plus a preload); the app's own text uses it from here on.
document.getElementById("fonts")?.setAttribute("media", "all");

/**
 * www.<domain> is only an alias: send visitors to the store's own address, where
 * sign-in and orders work (the API accepts requests from that one origin).
 */
function redirectFromWww(): boolean {
  if (!location.hostname.startsWith("www.")) return false;
  location.replace(`${location.protocol}//${location.hostname.slice(4)}${location.pathname}${location.search}${location.hash}`);
  return true;
}

/** The splash stays at least this long after the page opens (its drawing finishes), and never longer than the max. */
const SPLASH_MIN_MS = 900;
const SPLASH_MAX_MS = 6000;
let splashGone = false;

function hideSplash() {
  if (splashGone) return;
  splashGone = true;
  const el = document.getElementById("splash");
  if (!el) return;
  window.setTimeout(() => {
    el.classList.add("splash--out");
    window.setTimeout(() => el.remove(), 500);
  }, Math.max(0, SPLASH_MIN_MS - performance.now()));
}

/** Back in the app after a while (another tab, Telegram reopened): read the user and balance again. */
let lastSync = Date.now();
function syncOnReturn() {
  if (document.visibilityState !== "visible" || !getState().me || Date.now() - lastSync < 20_000) return;
  lastSync = Date.now();
  void refreshMe();
}

/** Inside Telegram: its language, theme events and the deep link it opened with. */
function setUpTelegram(w: TgWebApp) {
  let lang = getState().lang;
  try {
    if (!localStorage.getItem("gh.lang")) lang = w.initDataUnsafe.user?.language_code?.startsWith("ar") ? "ar" : w.initDataUnsafe.user?.language_code ? "en" : lang;
  } catch {
    /* ignore */
  }
  applyLang(lang);
  setState({ miniApp: true, lang });
  w.onEvent("themeChanged", applyTheme);
  w.onEvent("activated", syncOnReturn);
  // Deep links: startapp=p_<slug> opens a product, r_<code> is a friend's invite,
  // and the bot's buttons open the wallet, orders or the invite card.
  const sp = w.initDataUnsafe.start_param ?? new URLSearchParams(location.search).get("startapp") ?? undefined;
  if (sp?.startsWith("p_")) navigate(`/p/${sp.slice(2).replace(/[^a-z0-9-]/g, "")}`, { replace: true });
  else if (sp?.startsWith("v_")) navigate(`/p/${sp.slice(2).replace(/[^a-z0-9-]/g, "")}?review=1`, { replace: true });
  else if (sp?.startsWith("o_")) navigate(`/orders/${sp.slice(2).replace(/[^0-9a-f-]/g, "")}`, { replace: true });
  else if (sp?.startsWith("r_")) stashReferral(sp.slice(2));
  else if (sp === "wallet" || sp === "orders") navigate(`/${sp}`, { replace: true });
  else if (sp === "invite") navigate("/profile", { replace: true });
  else if (sp === "admin") navigate("/admin", { replace: true });
  applyTheme();
}

/** Run `fn` when the browser is idle after the page's load event (at the latest after 10 s). */
function afterLoad(fn: () => void): void {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    if ("requestIdleCallback" in window) window.requestIdleCallback(fn, { timeout: 4000 });
    else setTimeout(fn, 1000);
  };
  if (document.readyState === "complete") window.setTimeout(go, 1500);
  else window.addEventListener("load", () => window.setTimeout(go, 1500), { once: true });
  window.setTimeout(go, 10_000);
}

/** How long the page waits for telegram.org's script before showing the store anyway. */
const TELEGRAM_WAIT_MS = 3500;
const LATE = Symbol("late");

async function start() {
  applyLang(getState().lang);
  const root = createRoot(document.getElementById("root")!);

  const configP = api<PublicConfig>("/api/config").catch(() => null);
  // Opened from Telegram: treat it as the Mini App while its script loads (no "Sign in" button,
  // no trip to the sign-in page), and never wait forever for a slow telegram.org.
  const launch = isTelegramLaunch();
  if (launch) setState({ miniApp: true });
  const tgP = loadTelegram();
  const first = await Promise.race([tgP, new Promise<typeof LATE>((r) => setTimeout(() => r(LATE), TELEGRAM_WAIT_MS))]);
  if (first !== LATE) {
    if (first) setUpTelegram(first);
    else {
      if (launch) setState({ miniApp: false });
      captureReferralFromUrl();
    }
  }
  applyTheme();
  root.render(<App />);
  // The other screens load in the background once the page has finished loading
  // (its pictures included), so they never compete with the first screen, and
  // moving around stays instant afterwards.
  afterLoad(() => {
    void import("./screens/ProductSheet");
    void import("./screens/Orders");
    void import("./screens/Wallet");
    void import("./screens/Profile");
  });

  const config = await configP;
  if (config) {
    setState({ config });
    applyTheme();
    // Visits are counted once the page has loaded: the beacon never slows the first screen.
    const token = config.analytics?.cfBeacon;
    afterLoad(() => startAnalytics(token));
  }

  // telegram.org was slow: the store is already showing; finish Telegram's part when its script arrives.
  let w = first === LATE ? null : first;
  if (first === LATE) {
    w = await tgP;
    if (w) setUpTelegram(w);
    else {
      setState({ miniApp: false });
      captureReferralFromUrl();
    }
  }

  if (w) {
    if (!hasToken()) {
      try {
        const r = await api<{ token: string }>("/api/auth/telegram", { body: { initData: w.initData } });
        setToken(r.token);
      } catch {
        setState({ authChecked: true });
        return;
      }
    }
    const me = await refreshMe();
    if (!me) {
      // The saved token expired: sign in again with fresh launch data.
      try {
        const r = await api<{ token: string }>("/api/auth/telegram", { body: { initData: w.initData } });
        setToken(r.token);
        await refreshMe();
      } catch {
        setState({ authChecked: true });
      }
    }
  } else {
    await refreshMe();
  }
}

if (!redirectFromWww()) {
  document.addEventListener("visibilitychange", syncOnReturn);
  // The home page's products load alongside sign-in, so the splash opens onto a filled page.
  const home = location.pathname === "/" || location.pathname.startsWith("/p/");
  window.setTimeout(hideSplash, SPLASH_MAX_MS);
  void Promise.allSettled([start(), home ? prefetch("/api/catalog") : null]).then(hideSplash);
}
