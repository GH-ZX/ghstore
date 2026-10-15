/** Store settings: the theme for everyone, the SYP rate, how long orders wait for a person, invite rewards. */
import { useEffect, useState } from "react";
import { THEMES, type ThemePreset } from "@store/ui";
import { applyTheme, getState, PRESETS, setState, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import type { PublicConfig } from "../lib/types";
import { ErrorBox, Seg, Spinner, Switch } from "../ui/kit";
import { useAction } from "./common";

interface SettingsData {
  settings: Record<string, unknown>;
}

export function Settings() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<SettingsData>("/api/admin/settings");
  const action = useAction();
  const [rate, setRate] = useState("");
  const [hours, setHours] = useState("24");
  const [refPct, setRefPct] = useState("2");
  const [refDays, setRefDays] = useState("90");

  useEffect(() => {
    if (!data) return;
    const p = data.settings["referral.percent"];
    setRefPct(typeof p === "number" ? String(p) : "0");
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
    applyTheme();
  }

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 240 }} />;
  const preset = (data.settings["theme.preset"] as ThemePreset) ?? "energetic";
  const mode = (data.settings["theme.default_mode"] as "system" | "light" | "dark") ?? "system";
  const darkUi = getState().mode === "dark";

  return (
    <div className="stack">
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
