/** Profile: who you are, totals, preferences, ways to sign in, support, admin link and sign-out. */
import { store } from "@store/config";
import { useState } from "react";
import { api, ApiFail, setToken } from "../lib/api";
import { errorText } from "../lib/i18n";
import { copyText, usd } from "../lib/format";
import { navigate } from "../lib/router";
import { refreshMe, setLang, setMode, signOut, toast, useApp, useT, type Mode } from "../lib/state";
import { haptic, openExternal, openTelegramLink } from "../lib/telegram";
import type { Referral } from "../lib/types";
import { useApi } from "../lib/useApi";
import { ChevronIcon, GiftIcon, WalletIcon } from "../ui/icons";
import { Seg, Sheet, Switch } from "../ui/kit";
import { AdminLink, Shell } from "../ui/Shell";
import { EmailCode, linkWebLogin, RequireUser, startLink } from "./Login";

export function Profile() {
  const { t } = useT();
  return (
    <Shell title={t("profile")} narrow>
      <RequireUser>
        <ProfileView />
      </RequireUser>
    </Shell>
  );
}

function ProfileView() {
  const { t, lang } = useT();
  const { me, mode, miniApp, config } = useApp();
  if (!me) return null;
  // Support channels the owner set in Admin → Settings.
  const sup = config?.support;
  const bot = config?.telegram?.bot ?? store.telegramBot;
  const channel = config?.telegram?.channel ?? null;
  const supportLinks = [
    channel && { key: "ch", title: t("telegramChannel"), detail: channel.replace(/^https:\/\//, ""), href: channel, telegram: true },
    sup?.telegram && { key: "tg", title: t("supportTelegram"), detail: `@${sup.telegram}`, href: `https://t.me/${sup.telegram}`, telegram: true },
    sup?.whatsapp && { key: "wa", title: t("supportWhatsapp"), detail: `+${sup.whatsapp}`, href: `https://wa.me/${sup.whatsapp}`, telegram: false },
    sup?.email && { key: "em", title: t("supportEmail"), detail: sup.email, href: `mailto:${sup.email}`, telegram: false },
  ].filter((x): x is { key: string; title: string; detail: string; href: string; telegram: boolean } => Boolean(x));
  const u = me.user;
  const initial = (u.name || u.telegramUsername || u.email || "?").trim().charAt(0).toUpperCase();
  const handle = u.telegramUsername ? `@${u.telegramUsername}` : u.email ?? "";

  async function setNotify(v: boolean) {
    await api("/api/me", { method: "PATCH", body: { notify: v } }).catch(() => {});
    void refreshMe();
  }

  return (
    <div className="stack screen">
      <div className="card card--pad stack">
        <div className="wrap" style={{ gap: 14 }}>
          <span className="avatar" aria-hidden="true">
            {u.photoUrl ? <img src={u.photoUrl} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} /> : initial}
          </span>
          <span className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 19, fontWeight: 700 }}>{u.name || handle}</span>
            {handle && <span className="small muted num">{handle}</span>}
          </span>
        </div>
        <div className="stats">
          <div className="stat">
            <span className="num">{me.stats.orders}</span>
            <span className="small muted">{t("stOrders")}</span>
          </div>
          <div className="stat">
            <span className="num">{usd(me.stats.spentCents)}</span>
            <span className="small muted">{t("stSpent")}</span>
          </div>
        </div>
      </div>

      <div className="card card--pad wrap" style={{ gap: 12 }}>
        <span className="round-icon" style={{ borderRadius: 14, background: "var(--tile)" }}>
          <WalletIcon active />
        </span>
        <span className="stack-sm" style={{ flex: 1, gap: 2 }}>
          <span className="small muted">{t("yourBalance")}</span>
          <span className="num" style={{ fontSize: 20, fontWeight: 700 }}>
            {usd(me.balanceCents)}
          </span>
        </span>
        <button type="button" className="btn btn--sm press" onClick={() => navigate("/wallet?topup=1000")}>
          {t("topUp")}
        </button>
      </div>

      <InviteCard />

      <div className="card" style={{ padding: "6px 16px" }}>
        <div className="small muted" style={{ padding: "10px 0 2px" }}>
          {t("prefs")}
        </div>
        <div className="pref-row">
          <span>{t("notifications")}</span>
          <Switch checked={u.notify} onChange={setNotify} label={t("notifications")} />
        </div>
        <div className="pref-row">
          <span>{t("language")}</span>
          <Seg
            label={t("language")}
            value={lang}
            onChange={setLang}
            options={[
              { value: "ar", label: "العربية" },
              { value: "en", label: "English" },
            ]}
          />
        </div>
        <div className="pref-row">
          <span>{t("appearance")}</span>
          <Seg<Mode>
            label={t("appearance")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "system", label: t("mode_system") },
              { value: "light", label: t("mode_light") },
              { value: "dark", label: t("mode_dark") },
            ]}
          />
        </div>
      </div>

      <LoginsCard />

      <div className="list">
        {supportLinks.map((s) => (
          <button key={s.key} type="button" className="list-row press" onClick={() => (s.telegram ? openTelegramLink(s.href) : openExternal(s.href))}>
            <span className="list-row__main">
              <span className="list-row__title">{s.title}</span>
              <span className="list-row__meta num" dir="ltr">{s.detail}</span>
            </span>
            <span className="muted">
              <ChevronIcon />
            </span>
          </button>
        ))}
        {!miniApp && u.hasTelegram === false && (
          <a className="list-row" href={`https://t.me/${bot}`} target="_blank" rel="noopener">
            <span className="list-row__main">
              <span className="list-row__title">{t("openInTelegram")}</span>
            </span>
            <span className="muted">
              <ChevronIcon />
            </span>
          </a>
        )}
        {u.role !== "customer" && <AdminLink />}
        {!miniApp && (
          <a
            className="list-row"
            style={{ color: "var(--bad)" }}
            href="/"
            onClick={(e) => {
              e.preventDefault();
              void signOut().then(() => navigate("/", { replace: true }));
            }}
          >
            <span className="list-row__main">
              <span className="list-row__title">{t("logout")}</span>
            </span>
          </a>
        )}
      </div>
    </div>
  );
}

/** "Invite friends": the customer's links and what they have earned (hidden when rewards are off). */
function InviteCard() {
  const { t } = useT();
  const { miniApp } = useApp();
  const { data } = useApi<Referral>("/api/me/referral");
  const { config } = useApp();
  if (!data?.enabled) return null;
  const botLink = `https://t.me/${config?.telegram?.bot ?? store.telegramBot}?start=r_${data.code}`;
  const webLink = `${location.origin}/?ref=${data.code}`;
  const shareLink = miniApp ? botLink : webLink;

  async function copy(text: string) {
    if (await copyText(text)) {
      haptic("success");
      toast(t("copied"));
    }
  }

  async function share() {
    if (miniApp) {
      openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(t("shareText"))}`);
      return;
    }
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: shareLink, text: t("shareText") });
        return;
      } catch {
        /* closed, or not allowed: copy instead */
      }
    }
    await copy(shareLink);
  }

  const links: [string, string][] = miniApp ? [[t("inviteTelegram"), botLink]] : [[t("inviteWeb"), webLink], [t("inviteTelegram"), botLink]];
  return (
    <div className="card card--pad stack" id="invite">
      <div className="wrap" style={{ gap: 12, flexWrap: "nowrap" }}>
        <span className="round-icon" style={{ borderRadius: 14, background: "var(--tile)", color: "var(--accent-text)", flex: "none" }}>
          <GiftIcon />
        </span>
        <span className="stack-sm" style={{ gap: 2 }}>
          <span style={{ fontWeight: 700 }}>{t("inviteTitle")}</span>
          <span className="small muted">{data.days > 0 ? t("inviteTextDays", { pct: data.percent, days: data.days }) : t("inviteText", { pct: data.percent })}</span>
        </span>
      </div>
      {links.map(([label, link]) => (
        <div key={link} className="stack-sm" style={{ gap: 6 }}>
          <span className="small muted">{label}</span>
          <div className="copy-box">
            <span>{link}</span>
            <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(link)}>
              {t("copy")}
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="btn btn--block press" onClick={share}>
        {t("share")}
      </button>
      <div className="stats" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="stat">
          <span className="num">{data.invited}</span>
          <span className="small muted">{t("invited")}</span>
        </div>
        <div className="stat">
          <span className="num">{data.buyers}</span>
          <span className="small muted">{t("buyers")}</span>
        </div>
        <div className="stat">
          <span className="num">{usd(data.earnedCents)}</span>
          <span className="small muted">{t("earned")}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Ways to sign in: Telegram and email/Google on one account, so the website,
 * the bot and the Mini App open the same wallet. Adding one on the website goes
 * through the sign-in page; in the Mini App, email is added right here.
 */
function LoginsCard() {
  const { t, lang } = useT();
  const { me, miniApp, config } = useApp();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkState, setLinkState] = useState("");
  if (!me) return null;
  const u = me.user;
  const methods = config?.login ?? ["telegram"];
  const webOn = !!config?.supabase && (methods.includes("email") || methods.includes("google"));
  const canAddTelegram = !u.hasTelegram && !miniApp && methods.includes("telegram");
  const canAddWeb = !u.email && webOn && (!miniApp || methods.includes("email"));
  // Nothing to show when only Telegram sign-in is on and this is a Telegram account.
  if (!u.email && !canAddWeb && u.hasTelegram && !canAddTelegram) return null;

  async function addOnWebsite(kind: "telegram" | "supabase") {
    try {
      await startLink(kind);
      navigate(`/login?link=1&with=${kind}&next=${encodeURIComponent("/profile")}`);
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    }
  }

  async function addEmailHere() {
    try {
      setLinkState(await startLink("supabase"));
      setAdding(true);
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    }
  }

  async function remove(provider: "telegram" | "supabase") {
    setBusy(true);
    try {
      const r = await api<{ token?: string }>("/api/me/unlink", { body: { provider } });
      // Removing a login signs out every other session; this one carries on with a fresh token.
      if (r.token) setToken(r.token);
      await refreshMe();
      toast(t("loginRemoved"));
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(false);
    }
  }

  const both = u.hasTelegram && !!u.email;
  return (
    <div className="card" style={{ padding: "6px 16px" }}>
      <div className="small muted" style={{ padding: "10px 0 2px" }}>
        {t("logins")}
      </div>
      <div className="pref-row">
        <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <span>Telegram</span>
          {u.hasTelegram && <span className="small muted num">{u.telegramUsername ? `@${u.telegramUsername}` : t("linked")}</span>}
        </span>
        {u.hasTelegram ? (
          both && !miniApp && (
            <button type="button" className="btn btn--xs btn--ghost press" disabled={busy} onClick={() => remove("telegram")}>
              {t("removeLogin")}
            </button>
          )
        ) : canAddTelegram ? (
          <button type="button" className="btn btn--xs press" onClick={() => addOnWebsite("telegram")}>
            {t("connect")}
          </button>
        ) : null}
      </div>
      {(u.email || canAddWeb) && (
        <div className="pref-row">
          <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <span>{t("emailOrGoogle")}</span>
            {u.email && (
              <span className="small muted num" dir="ltr">
                {u.email}
              </span>
            )}
          </span>
          {u.email ? (
            both && (
              <button type="button" className="btn btn--xs btn--ghost press" disabled={busy} onClick={() => remove("supabase")}>
                {t("removeLogin")}
              </button>
            )
          ) : (
            <button type="button" className="btn btn--xs press" onClick={() => (miniApp ? addEmailHere() : addOnWebsite("supabase"))}>
              {t("connect")}
            </button>
          )}
        </div>
      )}
      <p className="small muted" style={{ margin: "4px 0 12px" }}>
        {t("loginsHint")}
      </p>
      {adding && (
        <Sheet onClose={() => setAdding(false)} label={t("linkTitle")}>
          <EmailCode
            onToken={async (token) => {
              try {
                await linkWebLogin(token, linkState);
                setAdding(false);
                toast(t("loginLinked"));
              } catch (e) {
                toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
              }
            }}
          />
        </Sheet>
      )}
    </div>
  );
}
