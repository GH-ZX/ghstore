/** Admin: layout, navigation and access. Monitors look, support staff also act on orders and top-ups, owners see everything. */
import { useEffect } from "react";
import { store } from "@store/config";
import { linkHandler, navigate, usePath } from "../lib/router";
import { setLang, useApp, useT } from "../lib/state";
import type { MsgKey } from "../lib/i18n";
import { Logo, Seg, Toast } from "../ui/kit";
import { AdminOrders } from "./Orders";
import { Broadcast } from "./Broadcast";
import { Catalog } from "./Catalog";
import { Coupons } from "./Coupons";
import { Overview } from "./Overview";
import { Settings } from "./Settings";
import { Suppliers } from "./Suppliers";
import { Topups } from "./Topups";
import { Users } from "./Users";

const SECTIONS: { path: string; key: MsgKey; owner?: boolean }[] = [
  { path: "/admin", key: "overview" },
  { path: "/admin/topups", key: "topups" },
  { path: "/admin/orders", key: "orders" },
  { path: "/admin/catalog", key: "catalog", owner: true },
  { path: "/admin/coupons", key: "coupons", owner: true },
  { path: "/admin/broadcast", key: "broadcast", owner: true },
  { path: "/admin/suppliers", key: "suppliers", owner: true },
  { path: "/admin/users", key: "users" },
  { path: "/admin/settings", key: "settings", owner: true },
];

export function Admin() {
  const { me, authChecked, lang } = useApp();
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
            {t(s.key)}
          </a>
        ))}
        <a href="/" onClick={linkHandler("/")}>
          {t("backToStore")}
        </a>
      </nav>
      <main className="admin__main screen" key={section.path}>
        <div className="toolbar">
          <h1>{t(section.key)}</h1>
          <Seg
            label={t("language")}
            value={lang}
            onChange={setLang}
            options={[
              { value: "ar", label: "ع" },
              { value: "en", label: "EN" },
            ]}
          />
        </div>
        {section.key === "overview" && <Overview />}
        {section.key === "topups" && <Topups canAct={canAct} />}
        {section.key === "orders" && <AdminOrders canAct={canAct} />}
        {section.key === "catalog" && <Catalog />}
        {section.key === "coupons" && <Coupons />}
        {section.key === "broadcast" && <Broadcast />}
        {section.key === "suppliers" && <Suppliers />}
        {section.key === "users" && <Users owner={owner} />}
        {section.key === "settings" && <Settings />}
      </main>
      <Toast />
    </div>
  );
}
