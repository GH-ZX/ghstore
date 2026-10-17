/** Routes: the store screens for everyone, /admin for staff. */
import { lazy, Suspense, type ReactNode } from "react";
import { match, usePath } from "./lib/router";
import { Store } from "./screens/Store";

// Only the store comes with the first page; the other screens load when first opened.
const LegalPage = lazy(() => import("./screens/Legal").then((m) => ({ default: m.LegalPage })));
const Login = lazy(() => import("./screens/Login").then((m) => ({ default: m.Login })));
const Orders = lazy(() => import("./screens/Orders").then((m) => ({ default: m.Orders })));
const OrderPage = lazy(() => import("./screens/Orders").then((m) => ({ default: m.OrderPage })));
const Profile = lazy(() => import("./screens/Profile").then((m) => ({ default: m.Profile })));
const Wallet = lazy(() => import("./screens/Wallet").then((m) => ({ default: m.Wallet })));

const Loading = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <div className="boot">
        <span />
      </div>
    }
  >
    {children}
  </Suspense>
);

const Admin = lazy(() => import("./admin/Admin").then((m) => ({ default: m.Admin })));

export function App() {
  const path = usePath();
  if (path === "/admin" || path.startsWith("/admin/")) {
    return (
      <Suspense fallback={<div className="boot"><span /></div>}>
        <Admin />
      </Suspense>
    );
  }
  if (path === "/login") return <Loading><Login /></Loading>;
  if (path === "/orders") return <Loading><Orders /></Loading>;
  const order = match("/orders/:id", path);
  if (order) return <Loading><OrderPage id={order.id!} /></Loading>;
  if (path === "/wallet") return <Loading><Wallet /></Loading>;
  if (path === "/profile") return <Loading><Profile /></Loading>;
  const legal = match("/legal/:slug", path);
  if (legal) return <Loading><LegalPage slug={legal.slug!} /></Loading>;
  // "/", "/p/:slug" and anything unknown show the store.
  return <Store />;
}
