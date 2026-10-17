/**
 * Routes: the store screens for everyone, /admin for staff, and over them the
 * overlay layer. A product (/p/<slug>) opens as a sheet over whatever screen it
 * was opened from, which stays mounted underneath (lib/router.ts).
 */
import { lazy, Suspense, type ReactNode } from "react";
import { closeOverlay, match, useOverlay, usePath } from "./lib/router";
import { Store } from "./screens/Store";

// Only the store comes with the first page; the other screens load when first opened.
const LegalPage = lazy(() => import("./screens/Legal").then((m) => ({ default: m.LegalPage })));
const Login = lazy(() => import("./screens/Login").then((m) => ({ default: m.Login })));
const Orders = lazy(() => import("./screens/Orders").then((m) => ({ default: m.Orders })));
const OrderPage = lazy(() => import("./screens/Orders").then((m) => ({ default: m.OrderPage })));
const Profile = lazy(() => import("./screens/Profile").then((m) => ({ default: m.Profile })));
const Wallet = lazy(() => import("./screens/Wallet").then((m) => ({ default: m.Wallet })));
// The product sheet loads on first open (and in the background after the store shows).
const ProductSheet = lazy(() => import("./screens/ProductSheet").then((m) => ({ default: m.ProductSheet })));

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

function Screen({ path }: { path: string }) {
  if (path === "/admin" || path.startsWith("/admin/")) return <Loading><Admin /></Loading>;
  if (path === "/login") return <Loading><Login /></Loading>;
  if (path === "/orders") return <Loading><Orders /></Loading>;
  const order = match("/orders/:id", path);
  if (order) return <Loading><OrderPage id={order.id!} /></Loading>;
  if (path === "/wallet") return <Loading><Wallet /></Loading>;
  if (path === "/profile") return <Loading><Profile /></Loading>;
  const legal = match("/legal/:slug", path);
  if (legal) return <Loading><LegalPage slug={legal.slug!} /></Loading>;
  // "/", "/c/:slug" and anything unknown show the store.
  return <Store />;
}

export function App() {
  const path = usePath();
  const overlay = useOverlay();
  const product = overlay ? match("/p/:slug", overlay) : null;
  return (
    <>
      <Screen path={path} />
      {product?.slug && (
        <Suspense fallback={null}>
          {/* A new product starts a fresh sheet (package, quantity, coupon, fields). */}
          <ProductSheet key={product.slug} slug={product.slug} onClose={closeOverlay} />
        </Suspense>
      )}
    </>
  );
}
