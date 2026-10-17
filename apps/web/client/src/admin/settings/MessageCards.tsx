/**
 * Admin → Settings: messages and switches — email receipts, website sign-in,
 * the daily summary, browser notifications, and orders and customers.
 */
import { useState } from "react";
import { store } from "@store/config";
import { api, ApiFail } from "../../lib/api";
import { errorText } from "../../lib/i18n";
import { toast, useT } from "../../lib/state";
import { Spinner, Switch } from "../../ui/kit";
import { strText, useSave, useSettingDraft, useSettings } from "./context";

/** A row with a label (and a hint under it) and a switch for one setting that is on unless set false, or off unless set true. */
function SwitchRow({ k, label, hint, onByDefault }: { k: string; label: string; hint?: string; onByDefault: boolean }) {
  const { settings } = useSettings();
  const { save } = useSave();
  const v = settings[k];
  const checked = onByDefault ? v !== false : v === true;
  return (
    <div className="pref-row">
      {hint ? (
        <span className="stack-xs">
          <span>{label}</span>
          <span className="small muted">{hint}</span>
        </span>
      ) : (
        <span>{label}</span>
      )}
      <Switch checked={checked} onChange={(on) => void save({ [k]: on })} label={label} />
    </div>
  );
}

const domain = (() => {
  try {
    return new URL(store.url).hostname;
  } catch {
    return "example.com";
  }
})();

export function EmailCard() {
  const { t, lang } = useT();
  const { busy, save } = useSave();
  const from = useSettingDraft("email.from", (s) => s.trim() || null, strText);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  /** "Send me a test", to a typed address or the owner's linked email, with a clear reason when it cannot. */
  async function testEmail() {
    setTesting(true);
    try {
      const r = await api<{ ok?: boolean; to?: string }>("/api/admin/email/test", { body: testTo.trim() ? { to: testTo.trim() } : {} });
      toast(t("testEmailSentTo", { to: r.to ?? "" }));
    } catch (e) {
      const f = e instanceof ApiFail ? e : new ApiFail("internal", 0);
      const why =
        f.field === "email.to" ? t("testEmailNoTo")
          : f.field === "RESEND_API_KEY" ? t("testEmailNoKey")
            : f.field === "email.from" ? t("testEmailNoFrom")
              : f.field === "to" ? t("invalidValue")
                : f.field ? `${t("testEmailFailed")}: ${f.field}`
                  : errorText(lang, f.code);
      toast(why, true);
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("emailReceipts")}</h2>
        <p className="hint">{t("emailReceiptsHint")}</p>
      </div>
      <SwitchRow k="email.receipts" label={t("emailReceiptsOn")} onByDefault />
      <label className="field">
        <span>{t("emailFrom")}</span>
        <input className="input" dir="ltr" value={from.text} placeholder={t("emailFromPh", { name: store.name, domain })} autoComplete="off" onChange={(e) => from.set(e.target.value)} />
      </label>
      <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void save({ "email.from": from.value })}>
        {busy ? <Spinner small /> : t("save")}
      </button>
      <label className="field">
        <span>{t("testEmailTo")}</span>
        <span className="input-wrap">
          <input className="input" dir="ltr" type="email" value={testTo} placeholder="you@example.com" autoComplete="email" onChange={(e) => setTestTo(e.target.value)} />
          <button type="button" className="btn btn--sm btn--ghost press" disabled={testing} onClick={() => void testEmail()}>
            {testing ? <Spinner small /> : t("sendTestEmail")}
          </button>
        </span>
        <span className="hint">{t("testEmailHint")}</span>
      </label>
    </section>
  );
}

export function LoginCard() {
  const { t } = useT();
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("websiteLogin")}</h2>
        <p className="hint">{t("websiteLoginHint")}</p>
      </div>
      <SwitchRow k="login.email" label={t("loginEmail")} onByDefault />
      <SwitchRow k="login.google" label={t("loginGoogle")} onByDefault={false} />
    </section>
  );
}

export function DailyCard() {
  const { t } = useT();
  const { settings } = useSettings();
  const { save } = useSave();
  const hour = typeof settings["reports.daily_hour"] === "number" ? (settings["reports.daily_hour"] as number) : 9;
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("dailySummary")}</h2>
        <p className="hint">{t("dailySummaryHint", { tz: store.timeZone })}</p>
      </div>
      <SwitchRow k="reports.daily" label={t("dailySummaryOn")} onByDefault />
      <SwitchRow k="notify.new_orders" label={t("newOrderAlerts")} onByDefault />
      <label className="field">
        <span>{t("dailySummaryHour")}</span>
        <select className="select" value={String(hour)} onChange={(e) => void save({ "reports.daily_hour": Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={String(h)}>
              {String(h).padStart(2, "0")}:00
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

/** Browser notifications for website customers: off by default (sending them needs the paid Workers plan). */
export function PushCard() {
  const { t } = useT();
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("pushTitle")}</h2>
      </div>
      <SwitchRow k="push.enabled" label={t("pushSwitch")} hint={t("pushSettingHint")} onByDefault={false} />
    </section>
  );
}

export function ServiceCard() {
  const { t } = useT();
  const { settings } = useSettings();
  const { save } = useSave();
  const ask = typeof settings["reviews.ask_hours"] === "number" ? (settings["reviews.ask_hours"] as number) : 3;
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("serviceTitle")}</h2>
        <p className="hint">{t("serviceHint")}</p>
      </div>
      <SwitchRow k="orders.failed_to_owner" label={t("failedToOwner")} hint={t("failedToOwnerHint")} onByDefault />
      <label className="field">
        <span>{t("reviewAsk")}</span>
        <select className="select" value={String(ask)} onChange={(e) => void save({ "reviews.ask_hours": Number(e.target.value) })}>
          {[0, 1, 3, 6, 12, 24, 48].map((h) => (
            <option key={h} value={h}>
              {h === 0 ? t("reviewAskOff") : t("reviewAskAfter", { n: h })}
            </option>
          ))}
        </select>
      </label>
      <SwitchRow k="images.resize" label={t("imagesResize")} hint={t("imagesResizeHint")} onByDefault={false} />
    </section>
  );
}
