/** Admin: layout, navigation and access. Monitors look, support staff also act on orders and top-ups, owners see everything. */
import { useEffect, type ReactNode } from "react";
import { store } from "@store/config";
import { linkHandler, navigate, usePath } from "../lib/router";
import { useApp, useT } from "../lib/state";
import type { MsgKey } from "../lib/i18n";
import { Logo, Toast } from "../ui/kit";
import { LangButton } from "../ui/Shell";
import {
  BoxIcon, ChartIcon, ExitIcon, GearIcon, HomeIcon, MegaphoneIcon, OverviewIcon, ReceiptIcon, SearchIcon, TicketIcon, TopupIcon, TruckIcon, UsersIcon,
} from "../ui/icons";
import { AdminOrders } from "./Orders";
import { Broadcast } from "./Broadcast";
import { Catalog } from "./Catalog";
import { HomeAdmin } from "./Home";
import { SeoAdmin } from "./Seo";
import { Coupons } from "./Coupons";
import { Overview } from "./Overview";
import { Profit } from "./Profit";
import { Settings } from "./Settings";
import { Suppliers } from "./Suppliers";
import { Topups } from "./Topups";
import { Users } from "./Users";

const SECTIONS: { path: string; key: MsgKey; icon: ReactNode; owner?: boolean }[] = [
  { path: "/admin", key: "overview", icon: <OverviewIcon /> },
  { path: "/admin/profit", key: "profit", icon: <ChartIcon />, owner: true },
  { path: "/admin/topups", key: "topups", icon: <TopupIcon /> },
  { path: "/admin/orders", key: "orders", icon: <ReceiptIcon /> },
  { path: "/admin/catalog", key: "catalog", icon: <BoxIcon />, owner: true },
  { path: "/admin/home", key: "homePage", icon: <HomeIcon />, owner: true },
  { path: "/admin/coupons", key: "coupons", icon: <TicketIcon />, owner: true },
  { path: "/admin/broadcast", key: "broadcast", icon: <MegaphoneIcon />, owner: true },
  { path: "/admin/suppliers", key: "suppliers", icon: <TruckIcon />, owner: true },
  { path: "/admin/users", key: "users", icon: <UsersIcon /> },
  { path: "/admin/seo", key: "seoPages", icon: <SearchIcon size={20} />, owner: true },
  { path: "/admin/settings", key: "settings", icon: <GearIcon />, owner: true },
];

export function Admin() {
  const { me, authChecked } = useApp();
  const { t } = useT();
  const path = usePath();

  useEffect(() => {
    if (!authChecked) return;
    if (!me) navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
    else if (me.user.role === "customer") navigate("/", { replace: true });
  }, [authChecked, me, path]);

  if (!me || me.user.role === "customer") {
    return (
      <div className="boot">
        <span />
      </div>
    );
  }
  const owner = me.user.role === "owner";
  const canAct = me.user.role !== "monitor";
  const visible = SECTIONS.filter((s) => owner || !s.owner);
  const section = [...visible].reverse().find((s) => path === s.path || path.startsWith(`${s.path}/`)) ?? visible[0]!;

  return (
    <div className="admin">
      <nav className="admin__nav" aria-label={t("admin")}>
        <a className="admin__brand" href="/" onClick={linkHandler("/")}>
          <Logo height={24} />
          <span className="small muted">{store.name}</span>
        </a>
        {visible.map((s) => (
          <a key={s.path} href={s.path} onClick={linkHandler(s.path)} aria-current={s === section ? "page" : undefined}>
            <span className="admin__icon">{s.icon}</span>
            {t(s.key)}
          </a>
        ))}
        <a href="/" onClick={linkHandler("/")}>
          <span className="admin__icon">
            <ExitIcon />
          </span>
          {t("backToStore")}
        </a>
      </nav>
      <main className="admin__main screen" key={section.path}>
        <div className="toolbar">
          <h1>{t(section.key)}</h1>
          <LangButton />
        </div>
        {section.key === "overview" && <Overview />}
        {section.key === "profit" && <Profit />}
        {section.key === "topups" && <Topups canAct={canAct} />}
        {section.key === "orders" && <AdminOrders canAct={canAct} />}
        {section.key === "catalog" && <Catalog />}
        {section.key === "homePage" && <HomeAdmin />}
        {section.key === "coupons" && <Coupons />}
        {section.key === "broadcast" && <Broadcast />}
        {section.key === "suppliers" && <Suppliers />}
        {section.key === "users" && <Users owner={owner} />}
        {section.key === "seoPages" && <SeoAdmin />}
        {section.key === "settings" && <Settings />}
      </main>
      <Toast />
    </div>
  );
}
