/**
 * Website sign-in: "Log in with Telegram" (same account and wallet as the bot),
 * or email (a password or a one-time code), or Google — through Supabase Auth's
 * REST API, then swapped for the store's own session cookie.
 * In the Mini App there is nothing to do: Telegram signs the user in.
 * The same screen links a second login to a signed-in account (?link=1).
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { store } from "@store/config";
import { api, setToken } from "../lib/api";
import { linkWebLogin, safeNext, takeLinkState } from "../lib/auth";
import { pick } from "../lib/i18n";
import { navigate, useQuery } from "../lib/router";
import { refreshMe, toast, toastFail, useApp, useT } from "../lib/state";
import { ContactMark, ShieldIcon } from "../ui/icons";
import { Logo, Spinner, Toast } from "../ui/kit";
import { EmailLogin } from "./EmailLogin";

// The moving pictures load after the form, so signing in never waits for them.
const LoginArt = lazy(() => import("./LoginArt").then((m) => ({ default: m.LoginArt })));

/**
 * Sign in, or with ?link=1 (from Profile) add another way to sign in to the
 * account you are using: Telegram on an email account, email or Google on a
 * Telegram account.
 */
export function Login() {
  const { t, lang } = useT();
  const { config, me, authChecked } = useApp();
  const query = useQuery();
  const next = safeNext(query.get("next"));
  const link = query.get("link") === "1";
  const only = query.get("with") === "telegram" ? "telegram" : query.get("with") === "supabase" ? "supabase" : null;
  const [busy, setBusy] = useState(false);
  // A Telegram login waiting for "Link" to be confirmed (link mode).
  const [pending, setPending] = useState<{ fields: Record<string, string>; state: string } | null>(null);
  const widget = useRef<HTMLDivElement>(null);
  const bot = config?.telegram?.bot ?? store.telegramBot;
  const sb = config?.supabase ?? null;
  const linking = link && !!me;
  // When linking, offer only the kinds of login the account does not have yet.
  const methods = (config?.login ?? ["telegram"]).filter(
    (m) => !linking || ((m === "telegram" ? !me!.user.hasTelegram : !me!.user.email) && (!only || (only === "telegram") === (m === "telegram"))),
  );
  const back = link ? `/login?link=1${only ? `&with=${only}` : ""}&next=${encodeURIComponent(next)}` : `/login?next=${encodeURIComponent(next)}`;

  useEffect(() => {
    if (me && !link) navigate(next, { replace: true });
    // Linking needs a signed-in account; without one this is a plain sign-in.
    if (authChecked && !me && link) navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
  }, [me, next, link, authChecked]);

  function done() {
    toast(t("loginLinked"));
    navigate(next, { replace: true });
  }

  async function finishWeb(accessToken: string) {
    if (link) {
      const state = takeLinkState("supabase");
      if (!state) {
        toast(t("linkExpired"), true);
        return;
      }
      await linkWebLogin(accessToken, state);
      done();
      return;
    }
    await api("/api/auth/web", { body: { accessToken, locale: lang } });
    await refreshMe();
    navigate(next, { replace: true });
  }

  // Coming back from Google: Supabase puts the access token in the URL fragment.
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const token = h.get("access_token");
    if (!token) return;
    history.replaceState(null, "", location.pathname + location.search);
    setBusy(true);
    finishWeb(token)
      .catch((e) => toastFail(e))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Telegram Login Widget in redirect mode (no inline script, so it works under the CSP):
  // Telegram sends the visitor back here with the signed fields in the query string.
  // The domain must be set once with @BotFather → /setdomain.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!q.get("hash") || !q.get("id") || !q.get("auth_date")) return;
    const fields: Record<string, string> = {};
    for (const k of ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]) {
      const v = q.get(k);
      if (v) fields[k] = v;
    }
    history.replaceState(null, "", back);
    if (link) {
      // Only a link this tab started, and only after the person confirms it.
      const state = takeLinkState("telegram");
      if (state) setPending({ fields, state });
      else toast(t("linkExpired"), true);
      return;
    }
    setBusy(true);
    api("/api/auth/telegram-widget", { body: fields })
      .then(() => refreshMe())
      .then(() => navigate(next, { replace: true }))
      .catch((e) => toastFail(e))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!methods.includes("telegram") || !widget.current) return;
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", bot);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "14");
    s.setAttribute("data-request-access", "write");
    s.setAttribute("data-lang", lang);
    s.setAttribute("data-auth-url", `${location.origin}${back}`);
    widget.current.replaceChildren(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods.join(","), lang, bot, back]);

  function google() {
    if (!sb) return;
    const redirect = `${location.origin}${back}`;
    location.href = `${sb.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}`;
  }

  async function confirmTelegram() {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api<{ token?: string }>("/api/me/link/telegram", { body: { ...pending.fields, state: pending.state } });
      if (r.token) setToken(r.token);
      await refreshMe();
      done();
    } catch (e) {
      toastFail(e);
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  if (pending) {
    const who = pending.fields.username ? `@${pending.fields.username}` : [pending.fields.first_name, pending.fields.last_name].filter(Boolean).join(" ");
    return (
      <LoginFrame>
          <div className="login__brand">
            <h1>{t("linkTitle")}</h1>
            <p className="muted">{t("linkConfirm", { name: who || "Telegram" })}</p>
          </div>
          <button type="button" className="btn btn--block press" disabled={busy} onClick={confirmTelegram}>
            {busy ? <Spinner small /> : t("linkConfirmBtn")}
          </button>
          <button type="button" className="btn btn--block btn--ghost press" disabled={busy} onClick={() => { setPending(null); navigate(next, { replace: true }); }}>
            {t("cancel")}
          </button>
      </LoginFrame>
    );
  }
  return (
    <LoginFrame back={{ href: linking ? next : "/", label: linking ? t("back") : t("backToStoreShort") }}>
        <div className="login__brand">
          <h1>{linking ? t("linkTitle") : t("signInTitle", { name: store.name })}</h1>
          <p className="muted">{linking ? t("linkText") : t("signInText")}</p>
        </div>
        {busy && (
          <div className="wrap" style={{ justifyContent: "center" }}>
            <Spinner small />
          </div>
        )}
        {methods.includes("telegram") && <div className="tg-widget" ref={widget} aria-label={t("withTelegram")} />}
        {methods.includes("google") && sb && (
          <button type="button" className="btn btn--block login-btn login-btn--google press" onClick={google}>
            <GoogleMark />
            {t("withGoogle")}
          </button>
        )}
        {(methods.includes("telegram") || methods.includes("google")) && methods.includes("email") && sb && <div className="divider">{t("orEmail")}</div>}
        {methods.includes("email") && sb && (
          <EmailLogin
            onToken={(token) =>
              finishWeb(token).catch((e) => {
                toastFail(e);
              })
            }
          />
        )}
        {linking && methods.length === 0 && <p className="small muted">{t("allLinked")}</p>}
        {methods.includes("telegram") && !linking && (
          <a className="login__bot press" href={`https://t.me/${bot}`} target="_blank" rel="noopener">
            <ContactMark kind="telegram" size={30} />
            <span>{t("orOpenBot")}</span>
          </a>
        )}
    </LoginFrame>
  );
}

/**
 * The sign-in page: the form on one half (the left on a computer, whatever the
 * language), the store's look on the other: its products' pictures and what it
 * offers. On a phone the pictures make a short band above the form.
 */
function LoginFrame({ back, children }: { back?: { href: string; label: string }; children: ReactNode }) {
  const { t, lang } = useT();
  const dir = lang === "ar" ? "rtl" : "ltr";
  return (
    <div className="login" dir="ltr">
      <main className="login__pane" dir={dir}>
        <div className="login__card screen">
          <div className="login__top">
            <a href="/" aria-label={store.name} onClick={(e) => { e.preventDefault(); navigate("/"); }}>
              <Logo height={30} />
            </a>
            {back && (
              <a className="login__back press" href={back.href} onClick={(e) => { e.preventDefault(); navigate(back.href); }}>
                {back.label}
              </a>
            )}
          </div>
          {children}
          <Agreement />
          <p className="login__safe small muted">
            <ShieldIcon size={13} /> {t("loginSafe")}
          </p>
        </div>
      </main>
      <Suspense fallback={<aside className="login__art" aria-hidden="true" />}>
        <LoginArt />
      </Suspense>
      <Toast />
    </div>
  );
}

/** "By continuing, you agree to the Terms and the Privacy policy", linked, when those pages are published. */
function Agreement() {
  const { t, lang } = useT();
  const { config } = useApp();
  const page = (slug: string) => config?.pages?.find((p) => p.slug === slug);
  const terms = page("terms");
  const privacy = page("privacy");
  if (!terms || !privacy) return null;
  const link = (p: { slug: string; titleAr: string; titleEn: string }) => (
    <a href={`/legal/${p.slug}`} onClick={(e) => { e.preventDefault(); navigate(`/legal/${p.slug}`); }}>
      {pick(lang, p.titleAr, p.titleEn)}
    </a>
  );
  return (
    <p className="login__agree small muted">
      {t("loginAgree").split(/(\{terms\}|\{privacy\})/).map((part, i) =>
        part === "{terms}" ? <span key={i}>{link(terms)}</span> : part === "{privacy}" ? <span key={i}>{link(privacy)}</span> : <span key={i}>{part}</span>,
      )}
    </p>
  );
}

/** Google's "G", in its colours. */
function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}
