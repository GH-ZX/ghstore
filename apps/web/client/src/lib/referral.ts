/**
 * Invite links: t.me/<bot>?start=r_<code> (bot), ?startapp=r_<code> (Mini App)
 * and /?ref=<code> (website). The code is kept until the visitor is signed in,
 * then sent once; the server links only brand-new customers.
 */
import { api } from "./api";

const KEY = "gh.ref";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const CODE_RE = /^[A-Za-z2-9]{6,12}$/;

export function stashReferral(code: string | null | undefined): void {
  if (!code || !CODE_RE.test(code)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* private mode: the link just won't count */
  }
}

/** Read ?ref=<code> from the address bar, keep it, and tidy the URL. */
export function captureReferralFromUrl(): void {
  const url = new URL(location.href);
  const code = url.searchParams.get("ref");
  if (!code) return;
  stashReferral(code);
  url.searchParams.delete("ref");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

let sending = false;

/** Send a kept invite code for the signed-in user (once). */
export async function claimReferral(): Promise<void> {
  if (sending) return;
  let saved: { code?: string; at?: number } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (!saved?.code) return;
  const clear = () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  };
  if (!saved.at || Date.now() - saved.at > MAX_AGE_MS || !CODE_RE.test(saved.code)) return clear();
  sending = true;
  try {
    await api("/api/me/referral", { body: { code: saved.code } });
    clear();
  } catch {
    /* try again next time */
  } finally {
    sending = false;
  }
}
