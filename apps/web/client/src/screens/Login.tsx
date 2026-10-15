/**
 * Website sign-in: "Log in with Telegram" (same account and wallet as the bot),
 * or email with a one-time code, or Google — both through Supabase Auth's REST
 * API, then swapped for the store's own session cookie.
 * In the Mini App there is nothing to do: Telegram signs the user in.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { store } from "@store/config";
import { api, ApiFail } from "../lib/api";
import { toLatinDigits } from "../lib/format";
import { errorText } from "../lib/i18n";
import { navigate, useQuery } from "../lib/router";
import { refreshMe, toast, useApp, useT } from "../lib/state";
import { ErrorBox, Logo, Spinner, Toast } from "../ui/kit";

/** Shows children only to a signed-in user; otherwise sends website visitors to sign in. */
export function RequireUser({ children }: { children: ReactNode }) {
  const { me, authChecked, miniApp } = useApp();
  const { t } = useT();
  useEffect(() => {
    if (authChecked && !me && !miniApp) {
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
    }
  }, [authChecked, me, miniApp]);
  if (me) return <>{children}</>;
  if (authChecked && miniApp) return <ErrorBox error={new ApiFail("unauthorized", 401)} onRetry={() => location.reload()} />;
  return (
    <div className="boot" style={{ minHeight: 240 }} aria-label={t("loading")}>
      <span />
    </div>
  );
}

function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export function Login() {
  const { t, lang } = useT();
  const { config, me } = useApp();
  const query = useQuery();
  const next = safeNext(query.get("next"));
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const widget = useRef<HTMLDivElement>(null);
  const methods = config?.login ?? ["telegram"];
  const sb = config?.supabase ?? null;

  useEffect(() => {
    if (me) navigate(next, { replace: true });
  }, [me, next]);

  async function finishWeb(accessToken: string) {
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
      .catch((e) => toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true))
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
    history.replaceState(null, "", `/login?next=${encodeURIComponent(next)}`);
    setBusy(true);
    api("/api/auth/telegram-widget", { body: fields })
      .then(() => refreshMe())
      .then(() => navigate(next, { replace: true }))
      .catch((e) => toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!methods.includes("telegram") || !widget.current) return;
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", store.telegramBot);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "14");
    s.setAttribute("data-request-access", "write");
    s.setAttribute("data-lang", lang);
    s.setAttribute("data-auth-url", `${location.origin}/login?next=${encodeURIComponent(next)}`);
    widget.current.replaceChildren(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods.join(","), lang]);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    if (!sb) return;
    setBusy(true);
    try {
      const res = await fetch(`${sb.url}/auth/v1/otp`, {
        method: "POST",
        headers: { apikey: sb.key, "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), create_user: true }),
      });
      if (!res.ok) throw new ApiFail(res.status === 429 ? "rate_limited" : "invalid_input", res.status);
      setSent(true);
    } catch (err) {
      toast(errorText(lang, err instanceof ApiFail ? err.code : "network"), true);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!sb) return;
    setBusy(true);
    try {
      const res = await fetch(`${sb.url}/auth/v1/verify`, {
        method: "POST",
        headers: { apikey: sb.key, "content-type": "application/json" },
        body: JSON.stringify({ type: "email", email: email.trim(), token: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { access_token?: string };
      if (!res.ok || !data.access_token) throw new ApiFail("invalid_input", res.status);
      await finishWeb(data.access_token);
    } catch (err) {
      toast(errorText(lang, err instanceof ApiFail ? err.code : "network"), true);
    } finally {
      setBusy(false);
    }
  }

  function google() {
    if (!sb) return;
    const redirect = `${location.origin}/login?next=${encodeURIComponent(next)}`;
    location.href = `${sb.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}`;
  }

  return (
    <div className="login">
      <div className="card login__card screen">
        <div className="login__brand">
          <a href="/" aria-label={store.name}>
            <Logo height={40} />
          </a>
          <h1>{t("signInTitle", { name: store.name })}</h1>
          <p className="muted">{t("signInText")}</p>
        </div>
        {busy && (
          <div className="wrap" style={{ justifyContent: "center" }}>
            <Spinner small />
          </div>
        )}
        {methods.includes("telegram") && (
          <>
            <div className="tg-widget" ref={widget} aria-label={t("withTelegram")} />
            <a className="btn btn--block btn--soft press" href={`https://t.me/${store.telegramBot}`} target="_blank" rel="noopener">
              {t("orOpenBot")}
            </a>
          </>
        )}
        {methods.includes("email") && sb && (
          <>
            <div className="divider">{t("or")}</div>
            {!sent ? (
              <form className="stack-sm" onSubmit={sendCode}>
                <label className="field">
                  <span>{t("email")}</span>
                  <input className="input" type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("emailPh")} autoComplete="email" />
                </label>
                <button className="btn btn--block press" disabled={busy || !email.includes("@")}>
                  {t("sendCode")}
                </button>
              </form>
            ) : (
              <form className="stack-sm" onSubmit={verify}>
                <p className="small muted">{t("codeSent", { email })}</p>
                <label className="field">
                  <span>{t("code")}</span>
                  <input className="input num" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(toLatinDigits(e.target.value).replace(/\D/g, "").slice(0, 10))} />
                </label>
                <button className="btn btn--block press" disabled={busy || code.length < 6}>
                  {t("verify")}
                </button>
                <button type="button" className="btn btn--block btn--ghost press" onClick={() => setSent(false)}>
                  {t("changeEmail")}
                </button>
              </form>
            )}
          </>
        )}
        {methods.includes("google") && sb && (
          <button type="button" className="btn btn--block btn--ghost press" onClick={google}>
            {t("withGoogle")}
          </button>
        )}
        <a className="small" href="/" style={{ textAlign: "center" }} onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          {t("backToStoreShort")}
        </a>
      </div>
      <Toast />
    </div>
  );
}
