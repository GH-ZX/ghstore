/**
 * Admin → Settings: loyalty levels (cashback by what a customer spent in 30
 * days) and safer top-ups (a new account's limit, top-ups per hour).
 */
import { dollarsToCents } from "../../lib/format";
import { useT } from "../../lib/state";
import { Spinner, Switch } from "../../ui/kit";
import { decimalText, intText, MoneyInput } from "../common";
import { numberIn, numText, useDraft, useSave, useSettingDraft, useSettings } from "./context";

type TierDraft = { min: string; pct: string };
const DEFAULT: TierDraft[] = [
  { min: "50", pct: "1" },
  { min: "200", pct: "2" },
  { min: "500", pct: "3" },
];

const tiersText = (raw: unknown): TierDraft[] =>
  Array.isArray(raw) ? (raw as { min_cents: number; percent: number }[]).map((x) => ({ min: String(x.min_cents / 100), pct: String(x.percent) })) : DEFAULT;

export function LoyaltyCard() {
  const { t } = useT();
  const { settings } = useSettings();
  const { busy, save } = useSave();
  const [tiers, setTiers] = useDraft(settings["loyalty.tiers"], tiersText);
  const enabled = settings["loyalty.enabled"] === true;
  const parsed = tiers.map((x) => ({ min_cents: dollarsToCents(x.min) ?? Number.NaN, percent: Number(x.pct) }));
  const ok = parsed.every((x, i) => Number.isFinite(x.min_cents) && x.min_cents >= 0 && x.percent >= 0 && x.percent <= 10 && (i === 0 || x.min_cents > parsed[i - 1]!.min_cents));
  const set = (i: number, k: keyof TierDraft, v: string) => setTiers((all) => all.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("loyaltyTitle")}</h2>
        <p className="hint">{t("loyaltyHint")}</p>
      </div>
      <div className="pref-row">
        <span>{t("loyaltyOn")}</span>
        <Switch checked={enabled} onChange={(v) => void save({ "loyalty.enabled": v })} label={t("loyaltyOn")} />
      </div>
      {tiers.map((x, i) => (
        <div key={i} className="form-grid">
          <label className="field">
            <span>{t("loyaltyFrom", { n: i + 1 })}</span>
            <MoneyInput value={x.min} onChange={(v) => set(i, "min", v)} max={7} />
          </label>
          <label className="field">
            <span>{t("loyaltyBack")}</span>
            <span className="input-wrap">
              <input className="input num" inputMode="decimal" value={x.pct} onChange={(e) => set(i, "pct", decimalText(e.target.value, 5))} />
              <span className="input-wrap__pre muted">%</span>
            </span>
          </label>
        </div>
      ))}
      {!ok && <span className="error-text">{t("loyaltyBad")}</span>}
      <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={busy || !ok} onClick={() => void save({ "loyalty.tiers": parsed })}>
        {busy ? <Spinner small /> : t("save")}
      </button>
    </section>
  );
}

export function SafetyCard() {
  const { t } = useT();
  const { busy, save } = useSave();
  const newMax = useSettingDraft("payments.new_account_max_cents", (s) => {
    const c = dollarsToCents(s);
    return c !== null && c >= 100 && c <= 1_000_000 ? c : undefined;
  }, numText("50", 100));
  const perHour = useSettingDraft("payments.topups_per_hour", numberIn(1, 50, { int: true }), numText("6"));
  const ok = newMax.value !== undefined && perHour.value != null;

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("safetyTitle")}</h2>
        <p className="hint">{t("safetyHint")}</p>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{t("safetyNewMax")}</span>
          <MoneyInput value={newMax.text} onChange={newMax.set} max={8} />
        </label>
        <label className="field">
          <span>{t("safetyPerHour")}</span>
          <input className="input num" inputMode="numeric" value={perHour.text} onChange={(e) => perHour.set(intText(e.target.value, 2))} />
        </label>
      </div>
      <button
        type="button"
        className="btn btn--sm press"
        style={{ alignSelf: "flex-start" }}
        disabled={busy || !ok}
        onClick={() => void save({ "payments.new_account_max_cents": newMax.value, "payments.topups_per_hour": perHour.value })}
      >
        {busy ? <Spinner small /> : t("save")}
      </button>
    </section>
  );
}
