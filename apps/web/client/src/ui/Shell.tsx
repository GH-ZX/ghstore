/** Customer layout: floating glass header, page, floating pill tab bar. */
import { useEffect, useState, type ReactNode } from "react";
import { store } from "@store/config";
import { usd } from "../lib/format";
import { linkHandler, usePath, back } from "../lib/router";
import { setLang, useApp, useT } from "../lib/state";
import { pushBack } from "../lib/telegram";
import type { MsgKey } from "../lib/i18n";
import { AdminIcon, GlobeIcon, OrdersIcon, ProfileIcon, SearchIcon, StoreIcon, WalletIcon } from "./icons";
import { ConfirmHost } from "./Confirm";
import { Logo, Toast } from "./kit";
import { SearchOverlay } from "./Search";

const TABS: { to: string; key: MsgKey; Icon: typeof StoreIcon }[] = [
  { to: "/", key: "store", Icon: StoreIcon },
  { to: "/orders", key: "orders", Icon: OrdersIcon },
  { to: "/wallet", key: "wallet", Icon: WalletIcon },
  { to: "/profile", key: "profile", Icon: ProfileIcon },
];

function isActive(tab: string, path: string): boolean {
  if (tab === "/") return path === "/" || path.startsWith("/p/") || path.startsWith("/c/");
  return path === tab || path.startsWith(`${tab}/`);
}

/** The globe: one tap switches Arabic and English. */
export function LangButton() {
  const { lang } = useApp();
  const { t } = useT();
  return (
    <button type="button" className="icon-btn press" onClick={() => setLang(lang === "ar" ? "en" : "ar")} aria-label={t("switchLang")} title={t("switchLang")}>
      <GlobeIcon />
    </button>
  );
}

export function Shell({ title, children, narrow }: { title?: string; children: ReactNode; narrow?: boolean }) {
  const { me, miniApp } = useApp();
  const { t } = useT();
  const path = usePath();
  const isRoot = TABS.some((x) => x.to === path);
  const [searching, setSearching] = useState(false);

  // In Telegram, show its back button on inner pages (an order, a product).
  useEffect(() => {
    if (!miniApp || isRoot) return;
    return pushBack(() => back("/"));
  }, [miniApp, isRoot, path]);

  const staff = me && me.user.role !== "customer";
  return (
    <>
      {/* The same way round in both languages: the logo on the left. */}
      <header className="header" dir="ltr">
        <a href="/" className="header__brand" onClick={linkHandler("/")} aria-label={store.name}>
          <Logo />
          <span className="header__sep" aria-hidden="true" />
          <span className="header__title" dir="auto">{title ?? t("store")}</span>
        </a>
        <nav className="header__nav" aria-label={t("nav")} dir="auto">
          {TABS.map(({ to, key }) => (
            <a key={to} href={to} onClick={linkHandler(to)} aria-current={isActive(to, path) ? "page" : undefined}>
              {t(key)}
            </a>
          ))}
          {staff && (
            <a href="/admin" onClick={linkHandler("/admin")}>
              {t("admin")}
            </a>
          )}
        </nav>
        <div className="header__actions">
          <button type="button" className="icon-btn press" onClick={() => setSearching(true)} aria-label={t("searchLabel")}>
            <SearchIcon />
          </button>
          <LangButton />
          {me ? (
            <a className="wallet-pill press" href="/wallet" onClick={linkHandler("/wallet")} aria-label={t("wallet")}>
              <WalletIcon size={18} active />
              <span className="num">{usd(me.balanceCents)}</span>
            </a>
          ) : (
            !miniApp && (
              <a className="btn btn--xs press" href="/login" onClick={linkHandler("/login")}>
                {t("signIn")}
              </a>
            )
          )}
        </div>
      </header>
      <main className={narrow ? "page page--narrow" : "page"}>{children}</main>
      <nav className="tabbar" aria-label={t("nav")}>
        {TABS.map(({ to, key, Icon }) => {
          const active = isActive(to, path);
          return (
            <a key={to} href={to} onClick={linkHandler(to)} aria-current={active ? "page" : undefined} className="press">
              <Icon active={active} />
              {t(key)}
            </a>
          );
        })}
      </nav>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
      <Toast />
      <ConfirmHost />
    </>
  );
}

export function AdminLink() {
  const { t } = useT();
  return (
    <a className="list-row" href="/admin" onClick={linkHandler("/admin")}>
      <span className="round-icon">
        <AdminIcon />
      </span>
      <span className="list-row__main">
        <span className="list-row__title">{t("admin")}</span>
      </span>
    </a>
  );
}
