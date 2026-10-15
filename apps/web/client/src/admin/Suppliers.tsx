/** Suppliers: switch on/off, low-balance alert, sync now. Keys live in Worker secrets. */
import { useState } from "react";
import { dollarsToCents, usd } from "../lib/format";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { ErrorBox, Switch } from "../ui/kit";
import { ago, useAction } from "./common";

interface Sup {
  id: string;
  name: string;
  enabled: boolean;
  low_balance_cents: string | number;
  balance_cents: string | number | null;
  health: string;
  last_sync_at: string | null;
  last_error: string | null;
}

export function Suppliers() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<{ suppliers: Sup[] }>("/api/admin/catalog");
  const action = useAction();
  const [low, setLow] = useState<Record<string, string>>({});

  async function patch(id: string, body: Record<string, unknown>) {
    if (await action.run(`/api/admin/suppliers/${id}`, { method: "PATCH", body })) void reload();
  }
  async function sync(id: string) {
    const r = await action.run<{ checked: number; repriced: number; paused: number; resumed: number }>(`/api/admin/suppliers/${id}/sync`, {}, t("syncNow"));
    if (r) void reload();
  }

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 240 }} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t("supplier")}</th>
            <th>{t("enabled")}</th>
            <th>{t("balance")}</th>
            <th>{t("lowBalanceAt")}</th>
            <th>{t("health")}</th>
            <th>{t("lastSync")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.suppliers.map((s) => {
            const lowValue = low[s.id] ?? (Number(s.low_balance_cents) / 100).toFixed(2);
            return (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                  <div className="small muted num">{s.id}</div>
                </td>
                <td>
                  <Switch checked={s.enabled} onChange={(v) => patch(s.id, { enabled: v })} label={t("enabled")} />
                </td>
                <td className="num">{s.balance_cents === null ? "—" : usd(Number(s.balance_cents))}</td>
                <td>
                  <div className="wrap">
                    <input className="input num" style={{ width: 96, minHeight: 38 }} inputMode="decimal" value={lowValue} onChange={(e) => setLow((x) => ({ ...x, [s.id]: e.target.value }))} />
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost press"
                      disabled={action.busy || dollarsToCents(lowValue) === null}
                      onClick={() => patch(s.id, { lowBalanceCents: dollarsToCents(lowValue) })}
                    >
                      {t("save")}
                    </button>
                  </div>
                </td>
                <td>
                  <span className={s.health === "ok" ? "badge badge--good" : s.health === "unknown" ? "badge" : "badge badge--bad"}>{s.health}</span>
                  {s.last_error && <div className="small bad" style={{ whiteSpace: "normal", maxWidth: 260 }}>{s.last_error}</div>}
                </td>
                <td>{ago(s.last_sync_at, lang)}</td>
                <td>
                  <button type="button" className="btn btn--xs press" disabled={action.busy || !s.enabled} onClick={() => sync(s.id)}>
                    {t("syncNow")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
