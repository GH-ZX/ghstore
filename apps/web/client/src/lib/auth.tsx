/**
 * Signing in, shared by the screens: the guard for signed-in pages, the
 * address to come back to, and linking a second login to an account.
 */
import { useEffect, type ReactNode } from "react";
import { api, ApiFail, setToken } from "./api";
import { navigate } from "./router";
import { refreshMe, useApp, useT } from "./state";
import { ErrorBox } from "../ui/kit";

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

/**
 * Where to go after signing in: a path on this site only. "//evil.example",
 * "/\evil.example" and anything with a backslash are refused (browsers read
 * those as another site).
 */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.includes("//") || raw.includes("\\")) return "/";
  try {
    return new URL(raw, location.origin).origin === location.origin ? raw : "/";
  } catch {
    return "/";
  }
}

export type LinkKind = "telegram" | "supabase";
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
export function takeLinkState(kind: LinkKind): string | null {
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
