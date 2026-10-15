/** Store settings: the Telegram bot connection, the theme for everyone, the SYP rate, how long orders wait for a person, invite rewards. */
import { useEffect, useState } from "react";
import { THEMES, type ThemePreset } from "@store/ui";
import { store } from "@store/config";
import { applyTheme, getState, PRESETS, setState, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import type { PublicConfig } from "../lib/types";
import { ErrorBox, Seg, Spinner, Switch } from "../ui/kit";
import { ago, useAction } from "./common";

interface SettingsData {
  settings: Record<string, unknown>;
}

interface BotStatus {
  configured: boolean;
  bot: string | null;
  expectedUrl: string;
  url: string | null;
  connected: boolean;
  pendingUpdates: number;
  lastError: { message: string; at: string | null } | null;
  error: string | null;
}

/** Owner only: is Telegram sending the bot's messages to this store? One tap connects it. */
function BotCard() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<BotStatus>("/api/admin/telegram");
  const action = useAction();
  const [fresh, setFresh] = useState<BotStatus | null>(null);
  if (error) return null; // support staff: the bot belongs to the owner
  const s = fresh ?? data;
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("botTitle")}</h2>
        <p className="hint">{t("botHint")}</p>
      </div>
      {!s ? (
        <div className="skeleton" style={{ height: 48 }} />
      ) : (
        <div className="stack-sm">
          <div className="pref-row">
            <span>{s.bot ? `@${s.bot}` : t("botTitle")}</span>
            {s.connected ? <span className="badge badge--good">{t("botConnected")}</span> : <span className="badge badge--warn">{t("botNotConnected")}</span>}
          </div>
          {!s.configured && <p className="hint">{t("botNoSecrets")}</p>}
          {s.error && <p className="hint">{t("botError", { msg: s.error })}</p>}
          {!s.connected && s.url && (
            <p className="hint">
              {t("botElsewhere")} <span dir="ltr" className="num">{s.url}</span>
            </p>
          )}
          {s.lastError && <p className="hint">{t("botLastError", { msg: s.lastError.message, when: ago(s.lastError.at, lang) })}</p>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn--sm press"
          disabled={action.busy || !s?.configured}
          onClick={async () => {
            const r = await action.run<BotStatus>("/api/admin/telegram/connect", {}, t("botDone"));
            if (r) setFresh(r);
          }}
        >
          {action.busy ? <Spinner small /> : s?.connected ? t("botReconnect") : t("botConnect")}
        </button>
        <button type="button" className="btn btn--sm btn--ghost press" disabled={action.busy} onClick={() => { setFresh(null); void reload(); }}>
          {t("botCheck")}
        </button>
      </div>
    </section>
  );
}

export function Settings() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<SettingsData>("/api/admin/settings");
  const action = useAction();
  const [rate, setRate] = useState("");
  const [hours, setHours] = useState("24");
  const [refPct, setRefPct] = useState("2");
  const [refDays, setRefDays] = useState("90");
  const [hour, setHour] = useState("9");
  const [tg, setTg] = useState("");
  const [wa, setWa] = useState("");
  const [email, setEmail] = useState("");
  const [stars, setStars] = useState("");

  useEffect(() => {
    if (!data) return;
    const p = data.settings["referral.percent"];
    setRefPct(typeof p === "number" ? String(p) : "0");
    const text = (k: string) => (typeof data.settings[k] === "string" ? (data.settings[k] as string) : "");
    setTg(text("support.telegram"));
    setWa(text("support.whatsapp"));
    setEmail(text("support.email"));
    const sr = data.settings["payments.stars_per_usd"];
    setStars(typeof sr === "number" ? String(sr) : "");
    const dh = data.settings["reports.daily_hour"];
    setHour(typeof dh === "number" ? String(dh) : "9");
    const d = data.settings["referral.days"];
    setRefDays(typeof d === "number" ? String(d) : "0");
    const r = data.settings["fx.syp_per_usd"];
    setRate(typeof r === "number" ? String(r) : "");
    const h = data.settings["orders.max_pending_hours"];
    setHours(typeof h === "number" ? String(h) : "24");
  }, [data]);

  async function put(key: string, value: unknown) {
    const ok = await action.run(`/api/admin/settings/${key}`, { method: "PUT", body: { value } });
    if (!ok) return;
    void reload();
    // Show the change here at once (other visitors get it within a minute).
    const cur = getState().config;
    if (!cur) return;
    if (key === "theme.preset") setState({ config: { ...cur, theme: { ...cur.theme, preset: value as PublicConfig["theme"]["preset"] } } });
    if (key === "theme.default_mode") setState({ config: { ...cur, theme: { ...cur.theme, defaultMode: value as PublicConfig["theme"]["defaultMode"] } } });
    if (key === "fx.syp_per_usd") setState({ config: { ...cur, sypPerUsd: value as number | null } });
    if (key.startsWith("support.")) setState({ config: { ...cur, support: { ...cur.support, [key.slice(8)]: value as string | null } } });
    if (key === "payments.stars_per_usd") setState({ config: { ...cur, payments: { ...cur.payments, starsPerUsd: value as number | null } } });
    applyTheme();
  }

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 240 }} />;
  const preset = (data.settings["theme.preset"] as ThemePreset) ?? "energetic";
  const mode = (data.settings["theme.default_mode"] as "system" | "light" | "dark") ?? "system";
  const darkUi = getState().mode === "dark";

  return (
    <div className="stack">
      <BotCard />

      <section className="card card--pad stack">
        <div>
          <h2>{t("theme")}</h2>
          <p className="hint">{t("themeHint")}</p>
        </div>
        <div className="theme-cards" role="radiogroup" aria-label={t("theme")}>
          {PRESETS.map((p) => {
            const th = THEMES[p];
            const c = darkUi ? th.dark : th.light;
            return (
              <button key={p} type="button" role="radio" aria-checked={preset === p} className="theme-card press" onClick={() => put("theme.preset", p)} disabled={action.busy}>
                <span style={{ fontFamily: th.headingFont, fontWeight: 700, fontSize: 16 }}>{th.label[lang]}</span>
                <span className="swatches">
                  {[c.bg, c.surface, c.accent, c.accentText, c.ink].map((col, i) => (
                    <span key={i} style={{ background: col }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <div className="pref-row">
          <span>{t("defaultMode")}</span>
          <Seg
            label={t("defaultMode")}
            value={mode}
            onChange={(v) => put("theme.default_mode", v)}
            options={[
              { value: "system", label: t("mode_system") },
              { value: "light", label: t("mode_light") },
              { value: "dark", label: t("mode_dark") },
            ]}
          />
        </div>
      </section>

      <section className="card card--pad stack-sm">
        <label className="field">
          <span>{t("sypRate")}</span>
          <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="—" />
          <span className="hint">{t("sypHint")}</span>
        </label>
        <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={action.busy || (rate.trim() !== "" && !(Number(rate) > 0 && Number(rate) < 1000))} onClick={() => put("fx.syp_per_usd", rate.trim() ? Number(rate) : null)}>
          {action.busy ? <Spinner small /> : t("save")}
        </button>
      </section>

      <section className="card card--pad stack-sm">
        <div>
          <h2>{t("referralTitle")}</h2>
          <p className="hint">{t("referralHint")}</p>
        </div>
        <div className="pref-row">
          <span>{t("referralOn")}</span>
          <Switch checked={data.settings["referral.enabled"] === true} onChange={(v) => put("referral.enabled", v)} label={t("referralOn")} />
        </div>
        <div className="form-grid">
          <label className="field">
            <span>{t("referralPct")}</span>
            <input className="input num" inputMode="decimal" value={refPct} onChange={(e) => setRefPct(e.target.value.replace(/[^\d.]/g, ""))} />
          </label>
          <label className="field">
            <span>{t("referralDays")}</span>
            <input className="input num" inputMode="numeric" value={refDays} onChange={(e) => setRefDays(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
        <button
          type="button"
          className="btn btn--sm press"
          style={{ alignSelf: "flex-start" }}
          disabled={action.busy || !(Number(refPct) >= 0 && Number(refPct) <= 20) || refDays === "" || Number(refDays) > 3650}
          onClick={async () => {
            await put("referral.percent", Math.round(Number(refPct) * 100) / 100);
            await put("referral.days", Number(refDays));
          }}
        >
          {t("save")}
        </button>
      </section>

      <section className="card card--pad stack-sm">
        <div>
          <h2>{t("supportTitle")}</h2>
          <p className="hint">{t("supportHint")}</p>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>{t("supportTelegram")}</span>
            <input className="input" dir="ltr" value={tg} placeholder={t("supportTgPh")} autoComplete="off"
              onChange={(e) => setTg(e.target.value.trim().replace(/^(https?:\/\/)?(t\.me\/|telegram\.me\/)/i, "").replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 32))} />
          </label>
          <label className="field">
            <span>{t("supportWhatsapp")}</span>
            <input className="input num" dir="ltr" inputMode="tel" value={wa} placeholder={t("supportWaPh")}
              onChange={(e) => setWa(e.target.value.replace(/[^0-9]/g, "").replace(/^00/, "").slice(0, 15))} />
          </label>
          <label className="field span-2">
            <span>{t("supportEmail")}</span>
            <input className="input" dir="ltr" type="email" value={email} placeholder={t("supportEmailPh")} onChange={(e) => setEmail(e.target.value.trim())} />
          </label>
        </div>
        <button
          type="button"
          className="btn btn--sm press"
          style={{ alignSelf: "flex-start" }}
          disabled={action.busy || (tg !== "" && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(tg)) || (wa !== "" && !/^[1-9][0-9]{7,14}$/.test(wa)) || (email !== "" && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/.test(email))}
          onClick={async () => {
            await put("support.telegram", tg || null);
            await put("support.whatsapp", wa || null);
            await put("support.email", email || null);
          }}
        >
          {t("save")}
        </button>
      </section>

      <section className="card card--pad stack-sm">
        <div>
          <h2>{t("starsTitle")}</h2>
          <p className="hint">{t("starsHint")}</p>
        </div>
        <label className="field">
          <span>{t("starsRate")}</span>
          <input className="input num" inputMode="numeric" value={stars} placeholder="—" onChange={(e) => setStars(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          {Number(stars) >= 1 && (
            <span className="hint num">
              {t("starsExample", { stars: (Number(stars) * 10).toLocaleString("en-US"), usd: `$${(Number(stars) * 10 * 0.013).toFixed(2)}` })}
            </span>
          )}
        </label>
        <button
          type="button"
          className="btn btn--sm press"
          style={{ alignSelf: "flex-start" }}
          disabled={action.busy || (stars !== "" && !(Number(stars) >= 1 && Number(stars) <= 1000))}
          onClick={() => put("payments.stars_per_usd", stars === "" ? null : Number(stars))}
        >
          {t("save")}
        </button>
      </section>

      <section className="card card--pad stack-sm">
        <div>
          <h2>{t("dailySummary")}</h2>
          <p className="hint">{t("dailySummaryHint", { tz: store.timeZone })}</p>
        </div>
        <div className="pref-row">
          <span>{t("dailySummaryOn")}</span>
          <Switch checked={data.settings["reports.daily"] !== false} onChange={(v) => put("reports.daily", v)} label={t("dailySummaryOn")} />
        </div>
        <label className="field">
          <span>{t("dailySummaryHour")}</span>
          <select className="select" value={hour} onChange={(e) => { setHour(e.target.value); void put("reports.daily_hour", Number(e.target.value)); }}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={String(h)}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card card--pad stack-sm">
        <label className="field">
          <span>{t("maxPending")}</span>
          <input className="input num" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ""))} />
        </label>
        <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={action.busy || !(Number(hours) >= 1 && Number(hours) <= 168)} onClick={() => put("orders.max_pending_hours", Number(hours))}>
          {t("save")}
        </button>
      </section>
    </div>
  );
}
