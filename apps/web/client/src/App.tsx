/** Routes: the store screens for everyone, /admin for staff. */
import { lazy, Suspense } from "react";
import { match, usePath } from "./lib/router";
import { Login } from "./screens/Login";
import { OrderPage, Orders } from "./screens/Orders";
import { Profile } from "./screens/Profile";
import { Store } from "./screens/Store";
import { Wallet } from "./screens/Wallet";

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
  if (path === "/login") return <Login />;
  if (path === "/orders") return <Orders />;
  const order = match("/orders/:id", path);
  if (order) return <OrderPage id={order.id!} />;
  if (path === "/wallet") return <Wallet />;
  if (path === "/profile") return <Profile />;
  // "/", "/p/:slug" and anything unknown show the store.
  return <Store />;
}
