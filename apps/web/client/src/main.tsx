/**
 * Start-up: Telegram (when opened from the bot), store settings and theme,
 * sign-in, then render. The page shows right away; data fills in as it comes.
 */
import { createRoot } from "react-dom/client";
import { api, hasToken, setToken } from "./lib/api";
import { captureReferralFromUrl, stashReferral } from "./lib/referral";
import { navigate } from "./lib/router";
import { applyLang, applyTheme, getState, refreshMe, setState } from "./lib/state";
import { loadTelegram } from "./lib/telegram";
import type { PublicConfig } from "./lib/types";
import { App } from "./App";

async function start() {
  applyLang(getState().lang);
  const root = createRoot(document.getElementById("root")!);

  const configP = api<PublicConfig>("/api/config").catch(() => null);
  const w = await loadTelegram();
  if (w) {
    let lang = getState().lang;
    try {
      if (!localStorage.getItem("gh.lang")) lang = w.initDataUnsafe.user?.language_code?.startsWith("ar") ? "ar" : w.initDataUnsafe.user?.language_code ? "en" : lang;
    } catch {
      /* ignore */
    }
    applyLang(lang);
    setState({ miniApp: true, lang });
    w.onEvent("themeChanged", applyTheme);
    // Deep links: startapp=p_<slug> opens a product, r_<code> is a friend's invite,
    // and the bot's buttons open the wallet, orders or the invite card.
    const sp = w.initDataUnsafe.start_param ?? new URLSearchParams(location.search).get("startapp") ?? undefined;
    if (sp?.startsWith("p_")) navigate(`/p/${sp.slice(2).replace(/[^a-z0-9-]/g, "")}`, { replace: true });
    else if (sp?.startsWith("r_")) stashReferral(sp.slice(2));
    else if (sp === "wallet" || sp === "orders") navigate(`/${sp}`, { replace: true });
    else if (sp === "invite") navigate("/profile", { replace: true });
    else if (sp === "admin") navigate("/admin", { replace: true });
  } else {
    captureReferralFromUrl();
  }
  applyTheme();
  root.render(<App />);

  const config = await configP;
  if (config) {
    setState({ config });
    applyTheme();
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

void start();
