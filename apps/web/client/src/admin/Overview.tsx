/** Today at a glance, supplier balances, background jobs and CSV exports. */
import { useState } from "react";
import { ApiFail, download } from "../lib/api";
import { usd } from "../lib/format";
import { errorText } from "../lib/i18n";
import { linkHandler } from "../lib/router";
import { toast, useApp, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { ErrorBox, Seg, Spinner } from "../ui/kit";
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
  const { me } = useApp();
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

      {me?.user.role === "owner" && <Exports />}
    </div>
  );
}

type Range = "7" | "30" | "90" | "365";

/** CSV downloads for a spreadsheet or the accountant (days follow the store's time zone). */
function Exports() {
  const { t, lang } = useT();
  const [range, setRange] = useState<Range>("30");
  const [busy, setBusy] = useState<string | null>(null);

  async function get(kind: "orders" | "topups" | "wallet") {
    const to = new Date();
    const from = new Date(to.getTime() - (Number(range) - 1) * 86_400_000);
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setBusy(kind);
    try {
      await download(`/api/admin/export/${kind}.csv?from=${day(from)}&to=${day(to)}`);
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card card--pad stack-sm">
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <h2>{t("exports")}</h2>
        <Seg<Range>
          label={t("exports")}
          value={range}
          onChange={setRange}
          options={[
            { value: "7", label: t("days7") },
            { value: "30", label: t("days30") },
            { value: "90", label: t("days90") },
            { value: "365", label: t("days365") },
          ]}
        />
      </div>
      <p className="hint">{t("exportsHint")}</p>
      <div className="wrap" style={{ gap: 8 }}>
        {(["orders", "topups", "wallet"] as const).map((k) => (
          <button key={k} type="button" className="btn btn--sm btn--soft press" disabled={busy !== null} onClick={() => get(k)}>
            {busy === k ? <Spinner small /> : t(`export_${k}`)}
          </button>
        ))}
      </div>
    </section>
  );
}
