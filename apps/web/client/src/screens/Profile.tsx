/** Profile: who you are, totals, preferences, support, admin link and sign-out. */
import { store } from "@store/config";
import { api } from "../lib/api";
import { usd } from "../lib/format";
import { navigate } from "../lib/router";
import { refreshMe, setLang, setMode, signOut, useApp, useT, type Mode } from "../lib/state";
import { openExternal } from "../lib/telegram";
import { ChevronIcon, WalletIcon } from "../ui/icons";
import { Seg, Switch } from "../ui/kit";
import { AdminLink, Shell } from "../ui/Shell";
import { RequireUser } from "./Login";

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
  const { me, mode, miniApp } = useApp();
  if (!me) return null;
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
            {initial}
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

      <div className="list">
        {store.support.telegram && !store.support.telegram.includes("REPLACE") && (
          <button type="button" className="list-row press" onClick={() => openExternal(store.support.telegram)}>
            <span className="list-row__main">
              <span className="list-row__title">{t("support")}</span>
            </span>
            <span className="muted">
              <ChevronIcon />
            </span>
          </button>
        )}
        {!miniApp && u.hasTelegram === false && (
          <a className="list-row" href={`https://t.me/${store.telegramBot}`} target="_blank" rel="noopener">
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
