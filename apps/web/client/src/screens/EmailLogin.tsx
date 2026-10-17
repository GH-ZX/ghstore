/**
 * Email sign-in through Supabase Auth's REST API: a password, a one-time code,
 * creating an account or resetting a password. Used by the sign-in page and by
 * Profile (adding email to a Telegram account in the Mini App).
 */
import { useState, type FormEvent } from "react";
import { ApiFail } from "../lib/api";
import { toLatinDigits } from "../lib/format";
import { errorText } from "../lib/i18n";
import { failText, toastFail, useApp, useT } from "../lib/state";
import { Spinner } from "../ui/kit";

/** Email with a one-time code through Supabase Auth; hands the access token to `onToken`. */
export function EmailCode({ onToken }: { onToken: (accessToken: string) => Promise<void> }) {
  const { t } = useT();
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
      toastFail(err, "network");
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
      toastFail(err, "network");
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

  const authFailText = (e: unknown): string => {
    if (e instanceof AuthFail) {
      if (e.status === 429 || e.code.includes("rate_limit")) return errorText(lang, "rate_limited");
      if (e.code === "invalid_credentials" || e.code === "invalid_grant") return t("pwWrong");
      if (e.code === "email_not_confirmed") return t("pwNotConfirmed");
      if (e.code === "weak_password") return t("pwWeak");
      if (e.code === "otp_expired" || e.status === 403) return t("codeWrong");
      return errorText(lang, "invalid_input");
    }
    return failText(e, "network");
  };

  const run = async (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr(authFailText(x));
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
