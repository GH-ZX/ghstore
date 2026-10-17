/**
 * Admin → Settings: the store's look and its money rules — theme, the SYP rate,
 * invite rewards, support contacts, top-up limits, Telegram Stars, virtual
 * numbers and how long an order may wait.
 */
import { THEMES, type ThemePreset } from "@store/ui";
import { dollarsToCents, usd } from "../../lib/format";
import { getState, PRESETS, useT } from "../../lib/state";
import { Seg, Spinner, Switch } from "../../ui/kit";
import { decimalText, intText, MoneyInput } from "../common";
import { numberIn, numText, strText, useSave, useSettingDraft, useSettings } from "./context";

/** About what Telegram pays the store for one Star, in cents. */
const STAR_CENTS = 1.3;

function SaveButton({ busy, disabled, onClick }: { busy: boolean; disabled: boolean; onClick: () => void }) {
  const { t } = useT();
  return (
    <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={busy || disabled} onClick={onClick}>
      {busy ? <Spinner small /> : t("save")}
    </button>
  );
}

export function ThemeCard() {
  const { t, lang } = useT();
  const { settings } = useSettings();
  const { busy, save } = useSave();
  const preset = (settings["theme.preset"] as ThemePreset) ?? "energetic";
  const mode = (settings["theme.default_mode"] as "system" | "light" | "dark") ?? "system";
  const darkUi = getState().mode === "dark";
  return (
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
            <button key={p} type="button" role="radio" aria-checked={preset === p} className="theme-card press" onClick={() => void save({ "theme.preset": p })} disabled={busy}>
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
          onChange={(v) => void save({ "theme.default_mode": v })}
          options={[
            { value: "system", label: t("mode_system") },
            { value: "light", label: t("mode_light") },
            { value: "dark", label: t("mode_dark") },
          ]}
        />
      </div>
    </section>
  );
}

export function SypCard() {
  const { t } = useT();
  const { busy, save } = useSave();
  const rate = useSettingDraft("fx.syp_per_usd", (s) => (s.trim() === "" ? null : Number(s) > 0 && Number(s) < 1000 ? Number(s) : undefined), numText(""));
  return (
    <section className="card card--pad stack-sm">
      <label className="field">
        <span>{t("sypRate")}</span>
        <input className="input num" inputMode="decimal" value={rate.text} onChange={(e) => rate.set(decimalText(e.target.value, 9))} placeholder="—" />
        <span className="hint">{t("sypHint")}</span>
      </label>
      <SaveButton busy={busy} disabled={rate.value === undefined} onClick={() => void save({ "fx.syp_per_usd": rate.value })} />
    </section>
  );
}

export function ReferralCard() {
  const { t } = useT();
  const { settings } = useSettings();
  const { busy, save } = useSave();
  const pct = useSettingDraft("referral.percent", numberIn(0, 20), numText("0"));
  const days = useSettingDraft("referral.days", numberIn(0, 3650, { int: true }), numText("0"));
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("referralTitle")}</h2>
        <p className="hint">{t("referralHint")}</p>
      </div>
      <div className="pref-row">
        <span>{t("referralOn")}</span>
        <Switch checked={settings["referral.enabled"] === true} onChange={(v) => void save({ "referral.enabled": v })} label={t("referralOn")} />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{t("referralPct")}</span>
          <input className="input num" inputMode="decimal" value={pct.text} onChange={(e) => pct.set(decimalText(e.target.value, 6))} />
        </label>
        <label className="field">
          <span>{t("referralDays")}</span>
          <input className="input num" inputMode="numeric" value={days.text} onChange={(e) => days.set(intText(e.target.value, 4))} />
        </label>
      </div>
      <SaveButton
        busy={busy}
        disabled={pct.value == null || days.value == null}
        onClick={() => void save({ "referral.percent": Math.round(pct.value! * 100) / 100, "referral.days": days.value })}
      />
    </section>
  );
}

const TG_NAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const WA_NUMBER = /^[1-9][0-9]{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/;
const CHANNEL = /^https:\/\/t\.me\/(\+[A-Za-z0-9_-]{8,64}|[A-Za-z][A-Za-z0-9_]{4,31})$/;
/** "" (not set) or text matching `re`; the value saved is null for "". */
const optional = (re: RegExp) => (s: string) => (s === "" ? null : re.test(s) ? s : undefined);

export function SupportCard() {
  const { t } = useT();
  const { busy, save } = useSave();
  const tg = useSettingDraft("support.telegram", optional(TG_NAME), strText);
  const wa = useSettingDraft("support.whatsapp", optional(WA_NUMBER), strText);
  const email = useSettingDraft("support.email", optional(EMAIL), strText);
  const channel = useSettingDraft("telegram.channel_url", optional(CHANNEL), strText);
  const bad = [tg, wa, email, channel].some((d) => d.value === undefined);
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("supportTitle")}</h2>
        <p className="hint">{t("supportHint")}</p>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{t("supportTelegram")}</span>
          <input className="input" dir="ltr" value={tg.text} placeholder={t("supportTgPh")} autoComplete="off"
            onChange={(e) => tg.set(e.target.value.trim().replace(/^(https?:\/\/)?(t\.me\/|telegram\.me\/)/i, "").replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 32))} />
        </label>
        <label className="field">
          <span>{t("supportWhatsapp")}</span>
          <input className="input num" dir="ltr" inputMode="tel" value={wa.text} placeholder={t("supportWaPh")}
            onChange={(e) => wa.set(intText(e.target.value, 17).replace(/^00/, "").slice(0, 15))} />
        </label>
        <label className="field span-2">
          <span>{t("telegramChannel")}</span>
          <input id="telegram-channel" className="input" dir="ltr" value={channel.text} placeholder="https://t.me/…" autoComplete="off"
            onChange={(e) => {
              const v = e.target.value.trim();
              // "@name", "t.me/name" and "https://t.me/name" all become https://t.me/name
              channel.set(v === "" ? "" : v.startsWith("@") ? `https://t.me/${v.slice(1)}` : /^(https?:\/\/)?t\.me\//i.test(v) ? `https://t.me/${v.replace(/^(https?:\/\/)?t\.me\//i, "")}` : v);
            }} />
          <span className="hint">{t("telegramChannelHint")}</span>
        </label>
        <label className="field span-2">
          <span>{t("supportEmail")}</span>
          <input className="input" dir="ltr" type="email" value={email.text} placeholder={t("supportEmailPh")} onChange={(e) => email.set(e.target.value.trim())} />
        </label>
      </div>
      <SaveButton
        busy={busy}
        disabled={bad}
        onClick={() =>
          void save({ "telegram.channel_url": channel.value, "support.telegram": tg.value, "support.whatsapp": wa.value, "support.email": email.value })
        }
      />
    </section>
  );
}

export function TopupLimitsCard() {
  const { t } = useT();
  const { busy, save } = useSave();
  const cents = (s: string) => dollarsToCents(s) ?? undefined;
  const min = useSettingDraft("payments.min_topup_cents", cents, numText("1", 100));
  const max = useSettingDraft("payments.max_topup_cents", cents, numText("1000", 100));
  const mn = min.value;
  const mx = max.value;
  const ok = mn !== undefined && mx !== undefined && mn >= 10 && mn <= 100_000 && mx >= 100 && mx <= 1_000_000 && mx >= mn;
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("topupLimitsTitle")}</h2>
        <p className="hint">{t("topupLimitsHint")}</p>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{t("topupMin")}</span>
          <MoneyInput value={min.text} onChange={min.set} max={8} />
        </label>
        <label className="field">
          <span>{t("topupMax")}</span>
          <MoneyInput value={max.text} onChange={max.set} max={8} />
        </label>
      </div>
      {!ok && <span className="error-text">{t("topupLimitsBad")}</span>}
      <SaveButton busy={busy} disabled={!ok} onClick={() => void save({ "payments.min_topup_cents": mn, "payments.max_topup_cents": mx })} />
    </section>
  );
}

export function StarsCard() {
  const { t } = useT();
  const { busy, save } = useSave();
  const stars = useSettingDraft("payments.stars_per_usd", numberIn(1, 1000, { int: true, empty: null }), numText(""));
  const n = stars.value ?? 0;
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("starsTitle")}</h2>
        <p className="hint">{t("starsHint")}</p>
      </div>
      <label className="field">
        <span>{t("starsRate")}</span>
        <input className="input num" inputMode="numeric" value={stars.text} placeholder="—" onChange={(e) => stars.set(intText(e.target.value, 4))} />
        {n >= 1 && (
          <span className="hint num">
            {t("starsExample", { stars: (n * 10).toLocaleString("en-US"), usd: usd(Math.round(n * 10 * STAR_CENTS)) })}
          </span>
        )}
      </label>
      <SaveButton busy={busy} disabled={stars.value === undefined} onClick={() => void save({ "payments.stars_per_usd": stars.value })} />
    </section>
  );
}

export function NumbersCard() {
  const { t } = useT();
  const { busy, save } = useSave();
  const retries = useSettingDraft("numbers.max_retries", numberIn(1, 20, { int: true }), numText("5"));
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("numbersTitle")}</h2>
        <p className="hint">{t("numbersHint")}</p>
      </div>
      <label className="field">
        <span>{t("numbersRetries")}</span>
        <input className="input num" inputMode="numeric" value={retries.text} onChange={(e) => retries.set(intText(e.target.value, 2))} />
      </label>
      <SaveButton busy={busy} disabled={retries.value == null} onClick={() => void save({ "numbers.max_retries": retries.value })} />
    </section>
  );
}

export function MaxPendingCard() {
  const { t } = useT();
  const { busy, save } = useSave();
  const hours = useSettingDraft("orders.max_pending_hours", numberIn(1, 168, { int: true }), numText("24"));
  return (
    <section className="card card--pad stack-sm">
      <label className="field">
        <span>{t("maxPending")}</span>
        <input className="input num" inputMode="numeric" value={hours.text} onChange={(e) => hours.set(intText(e.target.value, 3))} />
      </label>
      <SaveButton busy={busy} disabled={hours.value == null} onClick={() => void save({ "orders.max_pending_hours": hours.value })} />
    </section>
  );
}
