/** Today at a glance, supplier balances, background jobs and CSV exports. */
import { useState } from "react";
import { store } from "@store/config";
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
  suppliers: {
    id: string;
    name: string;
    enabled: boolean;
    balanceCents: number | null;
    low: boolean;
    lowBalanceCents: number;
    health: string;
    lastError: string | null;
    checkedAt: string | null;
    /** What its orders cost over the last 7 days, and how long the balance lasts at that pace. */
    spent7dCents: number;
    daysLeft: number | null;
  }[];
  jobs: { name: string; last_ok_at: string | null; last_error: string | null }[];
}

export function Overview() {
  const { t, lang } = useT();
  const { me } = useApp();
  const owner = me?.user.role === "owner";
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
        {kpi(t("profitToday"), usd(data.profitTodayCents), false, owner ? "/admin/profit" : undefined)}
        {kpi(t("ordersToday"), String(data.ordersToday))}
        {kpi(t("newUsers"), String(data.newUsersToday))}
        {kpi(t("toReview"), String(data.paymentsToReview), data.paymentsToReview > 0, "/admin/topups")}
        {kpi(t("openOrders"), String(data.ordersOpen), false, "/admin/orders")}
        {kpi(t("failedOrders"), String(data.ordersFailed), data.ordersFailed > 0, "/admin/orders")}
        {kpi(t("walletsTotal"), usd(data.walletsTotalCents))}
      </div>

      <h2>{t("supBalances")}</h2>
      <div className="sup-cards">
        {data.suppliers.map((s) => (
          <SupplierCard key={s.id} s={s} />
        ))}
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

      {owner && <Exports />}
    </div>
  );
}

/** A supplier's balance, how long it lasts at last week's pace, and whether it is working. */
function SupplierCard({ s }: { s: OverviewData["suppliers"][number] }) {
  const { t, lang } = useT();
  const state = !s.enabled ? "off" : s.health === "ok" ? "ok" : s.health === "unknown" ? "unknown" : "bad";
  const label = { off: t("supOff"), ok: t("supWorking"), unknown: t("supNotChecked"), bad: t("supProblem") }[state];
  const days = s.daysLeft;
  // A month of balance fills the meter.
  const fill = days === null ? (s.balanceCents ? 100 : 0) : Math.min(100, (days / 30) * 100);
  const tone = s.low || (days !== null && days < 3) ? "loss" : days !== null && days < 7 ? "warn" : "good";
  return (
    <div className={s.low ? "card card--pad sup-card sup-card--low" : "card card--pad sup-card"} style={{ opacity: s.enabled ? 1 : 0.55 }}>
      <div className="row-between" style={{ gap: 8 }}>
        <strong>{s.name}</strong>
        <span className={state === "ok" ? "badge badge--good" : state === "bad" ? "badge badge--bad" : "badge"}>{label}</span>
      </div>
      <span className={s.low ? "num sup-card__bal bad" : "num sup-card__bal"}>{s.balanceCents === null ? "—" : usd(s.balanceCents)}</span>
      {s.balanceCents !== null && (
        <div className="hbar__track">
          <span className={`hbar__fill hbar__fill--${tone}`} style={{ width: `${Math.max(2, fill)}%` }} />
        </div>
      )}
      <span className="small muted">
        {s.spent7dCents > 0 ? (days === 0 ? t("supRunsOut") : days !== null ? t("supDaysLeft", { n: days }) : "") : t("supNoSpend")}
        {s.spent7dCents > 0 && ` · ${t("supSpent7d", { n: usd(s.spent7dCents) })}`}
      </span>
      {s.low && <span className="small bad">{t("supLowAlert", { n: usd(s.lowBalanceCents) })}</span>}
      {s.lastError && state === "bad" && <span className="small muted sup-card__err">{s.lastError}</span>}
      {s.checkedAt && <span className="small muted">{t("supCheckedAt", { when: ago(s.checkedAt, lang) })}</span>}
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
    // Days in the store's time zone, as the server counts them.
    const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: store.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const to = new Date();
    const from = new Date(to.getTime() - (Number(range) - 1) * 86_400_000);
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
