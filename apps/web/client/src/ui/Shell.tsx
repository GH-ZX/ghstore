/** Customer layout: floating glass header, page, floating pill tab bar. */
import { useEffect, type ReactNode } from "react";
import { usd } from "../lib/format";
import { linkHandler, usePath, back } from "../lib/router";
import { setLang, useApp, useT } from "../lib/state";
import { pushBack } from "../lib/telegram";
import type { MsgKey } from "../lib/i18n";
import { AdminIcon, OrdersIcon, ProfileIcon, StoreIcon, WalletIcon } from "./icons";
import { Logo, Seg, Toast } from "./kit";

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

export function Shell({ title, children, narrow }: { title?: string; children: ReactNode; narrow?: boolean }) {
  const { me, lang, miniApp } = useApp();
  const { t } = useT();
  const path = usePath();
  const isRoot = TABS.some((x) => x.to === path);

  // In Telegram, show its back button on inner pages (an order, a product).
  useEffect(() => {
    if (!miniApp || isRoot) return;
    return pushBack(() => back("/"));
  }, [miniApp, isRoot, path]);

  const staff = me && me.user.role !== "customer";
  return (
    <>
      <header className="header">
        <a href="/" className="header__brand" onClick={linkHandler("/")} aria-label="GH Store">
          <Logo />
          <span className="header__sep" aria-hidden="true" />
          <span className="header__title">{title ?? t("store")}</span>
        </a>
        <nav className="header__nav" aria-label={t("nav")}>
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
          <Seg
            label={t("language")}
            value={lang}
            onChange={setLang}
            options={[
              { value: "ar", label: "ع" },
              { value: "en", label: "EN" },
            ]}
          />
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
      <Toast />
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
