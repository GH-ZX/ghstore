/**
 * Website sign-in: "Log in with Telegram" (same account and wallet as the bot),
 * or email (a password or a one-time code), or Google — through Supabase Auth's
 * REST API, then swapped for the store's own session cookie.
 * In the Mini App there is nothing to do: Telegram signs the user in.
 * The same screen links a second login to a signed-in account (?link=1).
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { store } from "@store/config";
import { api, ApiFail, setToken } from "../lib/api";
import { toLatinDigits, usd } from "../lib/format";
import { errorText, pick } from "../lib/i18n";
import { navigate, useQuery } from "../lib/router";
import { refreshMe, toast, useApp, useT } from "../lib/state";
import type { Category, ProductCard } from "../lib/types";
import { useApi } from "../lib/useApi";
import { BoltIcon, ContactMark, MethodMark, ShieldIcon, WalletIcon } from "../ui/icons";
import { ErrorBox, Logo, Spinner, Tile, Toast } from "../ui/kit";

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

type LinkKind = "telegram" | "supabase";
const stateKey = (kind: LinkKind) => `gh.link.${kind}`;

/**
 * Profile → Connect: ask the store for a one-time link token, kept in this tab
 * only. The link is sent with it when the person comes back from Telegram or
 * Google, so a link someone else crafted (without the token) does nothing.
 */
export async function startLink(kind: LinkKind): Promise<string> {
  const r = await api<{ state: string }>("/api/me/link/start", { body: { provider: kind } });
  try {
    sessionStorage.setItem(stateKey(kind), r.state);
  } catch {
    /* storage unavailable: this tab can still use the returned token */
  }
  return r.state;
}

/** The token from startLink, used once. */
function takeLinkState(kind: LinkKind): string | null {
  try {
    const s = sessionStorage.getItem(stateKey(kind));
    sessionStorage.removeItem(stateKey(kind));
    return s;
  } catch {
    return null;
  }
}

/** Profile → link a website login: swap a Supabase access token for a link on the signed-in account. */
export async function linkWebLogin(accessToken: string, state: string): Promise<void> {
  const r = await api<{ switched: boolean; token?: string }>("/api/me/link/web", { body: { accessToken, state } });
  // The login's own account had the history: the store moved us into it.
  if (r.token) setToken(r.token);
  await refreshMe();
}

/** Email with a one-time code through Supabase Auth; hands the access token to `onToken`. */
export function EmailCode({ onToken }: { onToken: (accessToken: string) => Promise<void> }) {
  const { t, lang } = useT();
  const { config } = useApp();
  const sb = config?.supabase ?? null;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

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
      await onToken(data.access_token);
    } catch (err) {
      toast(errorText(lang, err instanceof ApiFail ? err.code : "network"), true);
    } finally {
      setBusy(false);
    }
  }

  if (!sb) return null;
  return !sent ? (
    <form className="stack-sm" onSubmit={sendCode}>
      <label className="field">
        <span>{t("email")}</span>
        <input className="input" type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("emailPh")} autoComplete="email" />
      </label>
      <button className="btn btn--block press" disabled={busy || !email.includes("@")}>
        {busy ? <Spinner small /> : t("sendCode")}
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
        {busy ? <Spinner small /> : t("verify")}
      </button>
      <button type="button" className="btn btn--block btn--ghost press" onClick={() => setSent(false)}>
        {t("changeEmail")}
      </button>
    </form>
  );
}

/** A refused Supabase Auth call: its HTTP status and error code. */
class AuthFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Supabase Auth's REST API (the publishable key is meant for browsers). */
async function authCall<T>(sb: { url: string; key: string }, path: string, body: unknown, opts: { method?: string; token?: string } = {}): Promise<T> {
  const res = await fetch(`${sb.url}/auth/v1/${path}`, {
    method: opts.method ?? "POST",
    headers: { apikey: sb.key, "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new AuthFail(res.status, String(data.error_code ?? data.error ?? ""));
  return data as T;
}

type EmailMode = "password" | "code" | "set";

/**
 * Email sign-in on the website: with a password, or with a one-time code.
 * "Create an account" and "Forgot password?" take the same path: a code sent to
 * the address proves it is yours, then you choose the password. So a password
 * is never set on an address nobody confirmed. The reset code comes in
 * Supabase's "Reset password" email, the others in "Magic Link" / "Confirm signup".
 */
export function EmailLogin({ onToken }: { onToken: (accessToken: string) => Promise<void> }) {
  const { t, lang } = useT();
  const { config } = useApp();
  const sb = config?.supabase ?? null;
  const [mode, setMode] = useState<EmailMode>("password");
  const [creating, setCreating] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  // Once the code is accepted: its session, so a refused password can be retried without a new code.
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!sb) return null;
  const auth = sb;
  const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const resetting = mode === "set" && !creating;

  const go = (m: EmailMode, create = true) => {
    setMode(m);
    setCreating(create);
    setSent(false);
    setCode("");
    setPassword("");
    setSession(null);
    setErr(null);
  };

  const failText = (e: unknown): string => {
    if (e instanceof AuthFail) {
      if (e.status === 429 || e.code.includes("rate_limit")) return errorText(lang, "rate_limited");
      if (e.code === "invalid_credentials" || e.code === "invalid_grant") return t("pwWrong");
      if (e.code === "email_not_confirmed") return t("pwNotConfirmed");
      if (e.code === "weak_password") return t("pwWeak");
      if (e.code === "otp_expired" || e.status === 403) return t("codeWrong");
      return errorText(lang, "invalid_input");
    }
    return errorText(lang, e instanceof ApiFail ? e.code : "network");
  };

  const run = async (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr(failText(x));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<string> => {
    const r = await authCall<{ access_token?: string }>(auth, "verify", { type: resetting ? "recovery" : "email", email: email.trim(), token: code.trim() });
    if (!r.access_token) throw new AuthFail(403, "otp_expired");
    return r.access_token;
  };

  const signIn = (e: FormEvent) =>
    run(e, async () => {
      const r = await authCall<{ access_token?: string }>(auth, "token?grant_type=password", { email: email.trim(), password });
      if (!r.access_token) throw new AuthFail(400, "invalid_credentials");
      await onToken(r.access_token);
    });

  const sendCode = (e: FormEvent) =>
    run(e, async () => {
      if (resetting) await authCall(auth, "recover", { email: email.trim() });
      else await authCall(auth, "otp", { email: email.trim(), create_user: true });
      setSent(true);
    });

  const codeIn = (e: FormEvent) => run(e, async () => onToken(await verify()));

  const choosePassword = (e: FormEvent) =>
    run(e, async () => {
      const token = session ?? (await verify());
      setSession(token);
      try {
        await authCall(auth, "user", { password }, { method: "PUT", token });
      } catch (x) {
        // The same password as before is fine: the code already proved it is you.
        if (!(x instanceof AuthFail && x.code === "same_password")) throw x;
      }
      await onToken(token);
    });

  const link = (label: string, onClick: () => void) => (
    <button type="button" className="link-btn" onClick={onClick}>
      {label}
    </button>
  );
  const emailField = (
    <label className="field">
      <span>{t("email")}</span>
      <input className="input" type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("emailPh")} autoComplete="email" />
    </label>
  );
  const codeField = (
    <label className="field">
      <span>{t("code")}</span>
      <input
        className="input num"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        value={code}
        onChange={(e) => setCode(toLatinDigits(e.target.value).replace(/\D/g, "").slice(0, 10))}
      />
    </label>
  );
  const error = err && (
    <p className="error-text" role="alert">
      {err}
    </p>
  );

  if (mode === "password")
    return (
      <form className="stack-sm" onSubmit={signIn}>
        {emailField}
        <div className="field">
          <span className="row-between">
            <label htmlFor="login-pw">{t("password")}</label>
            {link(t("pwForgot"), () => go("set", false))}
          </span>
          <PasswordInput id="login-pw" value={password} onChange={setPassword} autoComplete="current-password" />
        </div>
        {error}
        <button className="btn btn--block press" disabled={busy || !okEmail || !password}>
          {busy ? <Spinner small /> : t("signIn")}
        </button>
        <div className="email-alt">
          {link(t("pwCreate"), () => go("set", true))}
          {link(t("pwUseCode"), () => go("code"))}
        </div>
      </form>
    );

  if (mode === "code")
    return (
      <form className="stack-sm" onSubmit={sent ? codeIn : sendCode}>
        {sent ? <p className="small muted">{t("codeSent", { email })}</p> : emailField}
        {sent && codeField}
        {error}
        <button className="btn btn--block press" disabled={busy || (sent ? code.length < 6 : !okEmail)}>
          {busy ? <Spinner small /> : sent ? t("verify") : t("sendCode")}
        </button>
        <div className="email-alt">
          {sent && link(t("changeEmail"), () => go("code"))}
          {link(t("pwUsePassword"), () => go("password"))}
        </div>
      </form>
    );

  return (
    <form className="stack-sm" onSubmit={sent ? choosePassword : sendCode}>
      <div className="email-set__head">
        <strong>{creating ? t("pwCreateTitle") : t("pwResetTitle")}</strong>
        <span className="small muted">{!sent ? t("pwSetHint") : resetting ? t("pwResetSent", { email }) : t("codeSent", { email })}</span>
      </div>
      {sent ? <input type="email" autoComplete="username" value={email} readOnly hidden /> : emailField}
      {sent && !session && codeField}
      {sent && (
        <div className="field">
          <label htmlFor="login-new-pw">{t("pwNew")}</label>
          <PasswordInput id="login-new-pw" value={password} onChange={setPassword} autoComplete="new-password" />
          <span className="small muted">{t("pwRule")}</span>
        </div>
      )}
      {error}
      <button className="btn btn--block press" disabled={busy || (sent ? (!session && code.length < 6) || password.length < 8 : !okEmail)}>
        {busy ? <Spinner small /> : !sent ? t("sendCode") : creating ? t("pwCreateBtn") : t("pwSaveBtn")}
      </button>
      <div className="email-alt">{link(t("pwBack"), () => go("password"))}</div>
    </form>
  );
}

/** A password box with a button to show what was typed. */
function PasswordInput({ id, value, onChange, autoComplete }: { id: string; value: string; onChange: (v: string) => void; autoComplete: "current-password" | "new-password" }) {
  const { t } = useT();
  const [show, setShow] = useState(false);
  return (
    <div className="pw" dir="ltr">
      <input
        id={id}
        className="input"
        type={show ? "text" : "password"}
        required
        minLength={autoComplete === "new-password" ? 8 : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
      />
      <button type="button" className="pw__eye press" aria-label={show ? t("pwHide") : t("pwShow")} aria-pressed={show} onClick={() => setShow((s) => !s)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {show && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </div>
  );
}

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
      .catch((e) => toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true))
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
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  const hasWeb = methods.includes("email") || methods.includes("google");
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
                toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
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
          <p className="login__safe small muted">
            <ShieldIcon size={13} /> {t("loginSafe")}
          </p>
        </div>
      </main>
      <LoginArt />
      <Toast />
    </div>
  );
}

/**
 * Products with a real picture, one category after another (games, AI, gift
 * cards, numbers…), so the mix shows the whole store, each picture once.
 */
function mixAcross(products: ProductCard[]): ProductCard[] {
  const seen = new Set<string>();
  const groups = new Map<string, ProductCard[]>();
  for (const p of [...products].sort((a, b) => Number(b.featured) - Number(a.featured))) {
    if (!p.imageUrl || /simpleicons|favicons|\.svg(\?|$)/i.test(p.imageUrl) || seen.has(p.imageUrl)) continue;
    seen.add(p.imageUrl);
    groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
  }
  const lists = [...groups.values()];
  const out: ProductCard[] = [];
  for (let i = 0; out.length < 36 && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return out;
}

const ROW = 12;
const NEXT_MS = 2800;

/**
 * The sign-in page's other half, always moving: three rows of the store's
 * products drifting past, soft colours slowly changing place, and a card that
 * shows one product after another (its category, name and price).
 */
function LoginArt() {
  const { t, lang } = useT();
  const { data } = useApi<{ products: ProductCard[]; categories: Category[] }>("/api/catalog");
  const mix = useMemo(() => mixAcross(data?.products ?? []), [data]);
  const rows = useMemo(() => {
    const n = mix.length;
    if (!n) return [];
    const shift = Math.max(1, Math.floor(n / 3));
    return [0, 1, 2].map((r) => Array.from({ length: ROW }, (_, i) => mix[(r * shift + i) % n]!));
  }, [mix]);
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (mix.length < 2) return;
    const id = setInterval(() => setAt((i) => (i + 1) % mix.length), NEXT_MS);
    return () => clearInterval(id);
  }, [mix.length]);
  const cur = mix.length ? mix[at % mix.length] : undefined;
  const cat = cur ? data?.categories.find((c) => c.slug === cur.category) : undefined;
  return (
    <aside className="login__art" dir={lang === "ar" ? "rtl" : "ltr"} aria-hidden="true">
      <i className="login__blob login__blob--a" />
      <i className="login__blob login__blob--b" />
      <i className="login__blob login__blob--c" />
      <div className="login__rows" dir="ltr">
        {rows.map((row, r) => (
          <div key={r} className={`login__row login__row--${r}`}>
            <div className="login__track">
              {[...row, ...row].map((p, i) => (
                <Tile key={i} name={p.nameEn} imageUrl={p.imageUrl} className="login__tile" />
              ))}
            </div>
          </div>
        ))}
      </div>
      {cur && (
        <div className="login__now" key={at}>
          <Tile name={cur.nameEn} imageUrl={cur.imageUrl} className="login__now-tile" />
          <span className="login__now-text">
            {cat && <span className="login__now-cat">{pick(lang, cat.nameAr, cat.nameEn)}</span>}
            <b>{pick(lang, cur.nameAr, cur.nameEn)}</b>
            <span className="login__now-price">
              {t("from")} <span className="num">{usd(cur.fromCents)}</span>
              {!cur.byHand && <em>⚡ {t("instant")}</em>}
            </span>
          </span>
          <i className="login__now-bar" />
        </div>
      )}
      <div className="login__pitch">
        <h2>{t("loginArtTitle")}</h2>
        <ul>
          <li>
            <span className="login__perk-icon"><BoltIcon size={16} /></span>
            {t("loginPerk1")}
          </li>
          <li>
            <span className="login__perk-icon"><WalletIcon size={16} /></span>
            {t("loginPerk2")}
          </li>
          <li>
            <span className="login__marks">
              <MethodMark method="sam" size={24} />
              <MethodMark method="bep20" size={24} />
              <MethodMark method="stars" size={24} />
            </span>
            {t("loginPerk3")}
          </li>
        </ul>
      </div>
    </aside>
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
