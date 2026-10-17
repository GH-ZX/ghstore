/** Admin: layout, navigation and access. Monitors look, support staff also act on orders and top-ups, owners see everything. */
import { lazy, Suspense, useEffect, type ReactNode } from "react";
// The admin's strings (kept out of what customers download).
import "./messages";
import { store } from "@store/config";
import { ApiFail } from "../lib/api";
import { back, linkHandler, navigate, usePath } from "../lib/router";
import { useApp, useT } from "../lib/state";
import { pushBack } from "../lib/telegram";
import type { MsgKey } from "../lib/i18n";
import { ConfirmHost } from "../ui/Confirm";
import { ErrorBox, Logo, Toast } from "../ui/kit";
import { LangButton } from "../ui/Shell";
import {
  BoxIcon, ChartIcon, ExitIcon, GearIcon, HomeIcon, MegaphoneIcon, OverviewIcon, ReceiptIcon, SearchIcon, StarIcon, TicketIcon, TopupIcon, TruckIcon, UsersIcon,
} from "../ui/icons";

// Each section loads when first opened, so the admin's first screen comes quickly.
const AdminOrders = lazy(() => import("./Orders").then((m) => ({ default: m.AdminOrders })));
const Broadcast = lazy(() => import("./Broadcast").then((m) => ({ default: m.Broadcast })));
const Catalog = lazy(() => import("./Catalog").then((m) => ({ default: m.Catalog })));
const HomeAdmin = lazy(() => import("./Home").then((m) => ({ default: m.HomeAdmin })));
const SeoAdmin = lazy(() => import("./Seo").then((m) => ({ default: m.SeoAdmin })));
const ReviewsAdmin = lazy(() => import("./Reviews").then((m) => ({ default: m.ReviewsAdmin })));
const Coupons = lazy(() => import("./Coupons").then((m) => ({ default: m.Coupons })));
const Overview = lazy(() => import("./Overview").then((m) => ({ default: m.Overview })));
const Profit = lazy(() => import("./Profit").then((m) => ({ default: m.Profit })));
const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const Suppliers = lazy(() => import("./Suppliers").then((m) => ({ default: m.Suppliers })));
const Topups = lazy(() => import("./Topups").then((m) => ({ default: m.Topups })));
const Users = lazy(() => import("./Users").then((m) => ({ default: m.Users })));

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
  { path: "/admin/reviews", key: "reviews", icon: <StarIcon /> },
  { path: "/admin/seo", key: "seoPages", icon: <SearchIcon size={20} />, owner: true },
  { path: "/admin/settings", key: "settings", icon: <GearIcon />, owner: true },
];

export function Admin() {
  const { me, authChecked } = useApp();
  const { t } = useT();
  const { miniApp } = useApp();
  const path = usePath();

  useEffect(() => {
    if (!authChecked) return;
    // In the Mini App Telegram signs people in: there is no sign-in page to go to.
    if (!me) {
      if (!miniApp) navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
    } else if (me.user.role === "customer") navigate("/", { replace: true });
  }, [authChecked, me, path, miniApp]);

  // Telegram's back button: a section goes back to the overview, the overview to the store.
  useEffect(() => {
    if (!miniApp) return;
    return pushBack(() => back(path === "/admin" ? "/" : "/admin"));
  }, [miniApp, path]);

  if (authChecked && !me && miniApp) {
    return (
      <div className="admin__main screen">
        <ErrorBox error={new ApiFail("unauthorized", 401)} onRetry={() => location.reload()} />
      </div>
    );
  }
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
        <Suspense fallback={<div className="skeleton" style={{ height: 240 }} />}>
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
        {section.key === "reviews" && <ReviewsAdmin owner={owner} />}
        {section.key === "settings" && <Settings />}
        </Suspense>
      </main>
      <Toast />
      <ConfirmHost />
    </div>
  );
}
