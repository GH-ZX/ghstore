/**
 * Admin → Settings: loyalty levels (cashback by what a customer spent in 30
 * days) and safer top-ups (a new account's limit, top-ups per hour).
 */
import { useEffect, useState } from "react";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Spinner, Switch } from "../ui/kit";
import { useAction } from "./common";

interface SettingsData {
  settings: Record<string, unknown>;
}

type TierDraft = { min: string; pct: string };
const DEFAULT: TierDraft[] = [
  { min: "50", pct: "1" },
  { min: "200", pct: "2" },
  { min: "500", pct: "3" },
];

export function LoyaltyCard() {
  const { t } = useT();
  const action = useAction();
  const { data, reload } = useApi<SettingsData>("/api/admin/settings");
  const [tiers, setTiers] = useState<TierDraft[] | null>(null);
  useEffect(() => {
    if (!data || tiers) return;
    const raw = data.settings["loyalty.tiers"];
    setTiers(
      Array.isArray(raw)
        ? (raw as { min_cents: number; percent: number }[]).map((x) => ({ min: String(x.min_cents / 100), pct: String(x.percent) }))
        : DEFAULT,
    );
  }, [data, tiers]);
  if (!data || !tiers) return null;
  const enabled = data.settings["loyalty.enabled"] === true;
  const parsed = tiers.map((x) => ({ min_cents: Math.round(Number(x.min) * 100), percent: Number(x.pct) }));
  const ok = parsed.every((x, i) => Number.isFinite(x.min_cents) && x.min_cents >= 0 && x.percent >= 0 && x.percent <= 10 && (i === 0 || x.min_cents > parsed[i - 1]!.min_cents));
  const set = (i: number, k: keyof TierDraft, v: string) => setTiers((all) => all!.map((x, j) => (j === i ? { ...x, [k]: v.replace(/[^\d.]/g, "").slice(0, 7) } : x)));

  async function save(key: string, value: unknown) {
    if (await action.run(`/api/admin/settings/${key}`, { method: "PUT", body: { value } })) void reload();
  }

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("loyaltyTitle")}</h2>
        <p className="hint">{t("loyaltyHint")}</p>
      </div>
      <div className="pref-row">
        <span>{t("loyaltyOn")}</span>
        <Switch checked={enabled} onChange={(v) => void save("loyalty.enabled", v)} label={t("loyaltyOn")} />
      </div>
      {tiers.map((x, i) => (
        <div key={i} className="form-grid">
          <label className="field">
            <span>{t("loyaltyFrom", { n: i + 1 })}</span>
            <span className="input-wrap">
              <span className="input-wrap__pre muted">$</span>
              <input className="input num" inputMode="decimal" value={x.min} onChange={(e) => set(i, "min", e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span>{t("loyaltyBack")}</span>
            <span className="input-wrap">
              <input className="input num" inputMode="decimal" value={x.pct} onChange={(e) => set(i, "pct", e.target.value)} />
              <span className="input-wrap__pre muted">%</span>
            </span>
          </label>
        </div>
      ))}
      {!ok && <span className="error-text">{t("loyaltyBad")}</span>}
      <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={action.busy || !ok} onClick={() => void save("loyalty.tiers", parsed)}>
        {action.busy ? <Spinner small /> : t("save")}
      </button>
    </section>
  );
}

export function SafetyCard() {
  const { t } = useT();
  const action = useAction();
  const { data, reload } = useApi<SettingsData>("/api/admin/settings");
  const [newMax, setNewMax] = useState<string | null>(null);
  const [perHour, setPerHour] = useState<string | null>(null);
  if (!data) return null;
  const nm = data.settings["payments.new_account_max_cents"];
  const ph = data.settings["payments.topups_per_hour"];
  const newMaxV = newMax ?? String(typeof nm === "number" ? nm / 100 : 50);
  const perHourV = perHour ?? String(typeof ph === "number" ? ph : 6);
  const cents = Math.round(Number(newMaxV) * 100);
  const hours = Number(perHourV);
  const ok = cents >= 100 && cents <= 1_000_000 && Number.isInteger(hours) && hours >= 1 && hours <= 50;

  async function save() {
    const a = await action.run("/api/admin/settings/payments.new_account_max_cents", { method: "PUT", body: { value: cents } });
    const b = a && (await action.run("/api/admin/settings/payments.topups_per_hour", { method: "PUT", body: { value: hours } }));
    if (b) void reload();
  }

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("safetyTitle")}</h2>
        <p className="hint">{t("safetyHint")}</p>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{t("safetyNewMax")}</span>
          <span className="input-wrap">
            <span className="input-wrap__pre muted">$</span>
            <input className="input num" inputMode="decimal" value={newMaxV} onChange={(e) => setNewMax(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))} />
          </span>
        </label>
        <label className="field">
          <span>{t("safetyPerHour")}</span>
          <input className="input num" inputMode="numeric" value={perHourV} onChange={(e) => setPerHour(e.target.value.replace(/\D/g, "").slice(0, 2))} />
        </label>
      </div>
      <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={action.busy || !ok} onClick={() => void save()}>
        {action.busy ? <Spinner small /> : t("save")}
      </button>
    </section>
  );
}
