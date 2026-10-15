/** Today at a glance, supplier balances and background jobs. */
import { usd } from "../lib/format";
import { linkHandler } from "../lib/router";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { ErrorBox } from "../ui/kit";
import { ago } from "./common";

interface OverviewData {
  salesTodayCents: number;
  profitTodayCents: number;
  ordersToday: number;
  ordersOpen: number;
  ordersFailed: number;
  paymentsToReview: number;
  walletsTotalCents: number;
  newUsersToday: number;
  suppliers: { id: string; name: string; enabled: boolean; balanceCents: number | null; low: boolean; health: string; lastError: string | null }[];
  jobs: { name: string; last_ok_at: string | null; last_error: string | null }[];
}

export function Overview() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<OverviewData>("/api/admin/overview");
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 300 }} />;
  const kpi = (label: string, value: string, alert = false, to?: string) => {
    const body = (
      <>
        <span className="small muted">{label}</span>
        <span className="num">{value}</span>
      </>
    );
    return to ? (
      <a className={alert ? "kpi kpi--alert" : "kpi"} href={to} onClick={linkHandler(to)} style={{ color: "inherit", textDecoration: "none" }}>
        {body}
      </a>
    ) : (
      <div className={alert ? "kpi kpi--alert" : "kpi"}>{body}</div>
    );
  };
  return (
    <div className="stack">
      <div className="kpis">
        {kpi(t("salesToday"), usd(data.salesTodayCents))}
        {kpi(t("profitToday"), usd(data.profitTodayCents))}
        {kpi(t("ordersToday"), String(data.ordersToday))}
        {kpi(t("newUsers"), String(data.newUsersToday))}
        {kpi(t("toReview"), String(data.paymentsToReview), data.paymentsToReview > 0, "/admin/topups")}
        {kpi(t("openOrders"), String(data.ordersOpen), false, "/admin/orders")}
        {kpi(t("failedOrders"), String(data.ordersFailed), data.ordersFailed > 0, "/admin/orders")}
        {kpi(t("walletsTotal"), usd(data.walletsTotalCents))}
      </div>

      <h2>{t("suppliers")}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("supplier")}</th>
              <th>{t("balance")}</th>
              <th>{t("health")}</th>
              <th>{t("lastError")}</th>
            </tr>
          </thead>
          <tbody>
            {data.suppliers.map((s) => (
              <tr key={s.id} style={{ opacity: s.enabled ? 1 : 0.55 }}>
                <td>{s.name}</td>
                <td className={s.low ? "num bad" : "num"}>{s.balanceCents === null ? "—" : usd(s.balanceCents)}</td>
                <td>
                  <span className={s.health === "ok" ? "badge badge--good" : s.health === "unknown" ? "badge" : "badge badge--bad"}>{s.health}</span>
                </td>
                <td className="wrap-cell small muted">{s.lastError ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>{t("jobs")}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>{t("lastOk")}</th>
              <th>{t("lastError")}</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((j) => (
              <tr key={j.name}>
                <td className="num">{j.name}</td>
                <td>{ago(j.last_ok_at, lang)}</td>
                <td className="wrap-cell small bad">{j.last_error ?? ""}</td>
              </tr>
            ))}
            {data.jobs.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  {t("none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
