/**
 * Routes: the store screens for everyone, /admin for staff, and over them the
 * overlay layer. A product (/p/<slug>) opens as a sheet over whatever screen it
 * was opened from, which stays mounted underneath (lib/router.ts).
 */
import { Component, lazy, Suspense, type ReactNode } from "react";
import { useT } from "./lib/state";
import { closeOverlay, match, useOverlay, usePath } from "./lib/router";
import { Store } from "./screens/Store";
import { PageLoading } from "./ui/kit";
import { Shell } from "./ui/Shell";

// Only the store comes with the first page; the other screens load when first opened.
const LegalPage = lazy(() => import("./screens/Legal").then((m) => ({ default: m.LegalPage })));
const Login = lazy(() => import("./screens/Login").then((m) => ({ default: m.Login })));
const Orders = lazy(() => import("./screens/Orders").then((m) => ({ default: m.Orders })));
const OrderPage = lazy(() => import("./screens/Orders").then((m) => ({ default: m.OrderPage })));
const Profile = lazy(() => import("./screens/Profile").then((m) => ({ default: m.Profile })));
const Wallet = lazy(() => import("./screens/Wallet").then((m) => ({ default: m.Wallet })));
// The product sheet loads on first open (and in the background after the store shows).
const ProductSheet = lazy(() => import("./screens/ProductSheet").then((m) => ({ default: m.ProductSheet })));

// Full-screen pages (admin, sign-in) load on a blank screen; store screens load
// inside the store's frame, so the header and the bottom bar stay put.
const Loading = ({ children, bare }: { children: ReactNode; bare?: boolean }) => (
  <Suspense
    fallback={
      bare ? (
        <div className="boot">
          <span />
        </div>
      ) : (
        <Shell>
          <PageLoading />
        </Shell>
      )
    }
  >
    {children}
  </Suspense>
);

function Failed({ onRetry }: { onRetry: () => void }) {
  const { t } = useT();
  return (
    <Shell>
      <div className="empty" role="alert">
        <p>{t("e_internal")}</p>
        <button type="button" className="btn btn--soft press" onClick={onRetry}>
          {t("retry")}
        </button>
      </div>
    </Shell>
  );
}

/** A screen that throws shows "Something went wrong" in the store's frame, not a black page. */
class ScreenBoundary extends Component<{ path: string; children: ReactNode }, { failed: string | null }> {
  override state = { failed: null as string | null };
  static getDerivedStateFromError() {
    return { failed: location.pathname };
  }
  override componentDidCatch(err: unknown) {
    console.error("screen failed", err);
  }
  override render() {
    // Moving to another screen clears the failure.
    if (this.state.failed && this.state.failed === this.props.path) {
      return <Failed onRetry={() => location.reload()} />;
    }
    return this.props.children;
  }
}

const Admin = lazy(() => import("./admin/Admin").then((m) => ({ default: m.Admin })));

function Screen({ path }: { path: string }) {
  if (path === "/admin" || path.startsWith("/admin/")) return <Loading bare><Admin /></Loading>;
  if (path === "/login") return <Loading bare><Login /></Loading>;
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
      <ScreenBoundary path={path}>
        <Screen path={path} />
      </ScreenBoundary>
      {product?.slug && (
        <Suspense fallback={null}>
          {/* A new product starts a fresh sheet (package, quantity, coupon, fields). */}
          <ProductSheet key={product.slug} slug={product.slug} onClose={closeOverlay} />
        </Suspense>
      )}
    </>
  );
}
