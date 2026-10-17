/** Store settings: the Telegram bot connection, the theme for everyone, the SYP rate, how long orders wait for a person, invite rewards. */
import { useEffect, useState } from "react";
import { THEMES, type ThemePreset } from "@store/ui";
import { store } from "@store/config";
import { api, ApiFail } from "../lib/api";
import { errorText } from "../lib/i18n";
import { applyTheme, getState, PRESETS, setState, toast, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import type { PublicConfig } from "../lib/types";
import { ErrorBox, Seg, Spinner, Switch } from "../ui/kit";
import { AccountsCard } from "./Accounts";
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
  staffBot: { username: string | null; error: string | null } | null;
}

interface StoreKey {
  name: string;
  group: "payments" | "suppliers" | "telegram" | "email" | "storage";
  label: string;
  source: "admin" | "worker" | null;
  hint: string | null;
  updatedAt: string | null;
}

/** Owner only: payment and supplier keys. Values go in, never come back out: the list shows only where each is set. */
function KeysCard() {
  const { t } = useT();
  const { data, error } = useApi<{ keys: StoreKey[] }>("/api/admin/keys");
  const action = useAction();
  const [fresh, setFresh] = useState<StoreKey[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (error) return null; // support staff never see keys
  const keys = fresh ?? data?.keys;

  async function save(name: string, value: string | null) {
    const r = await action.run<{ keys: StoreKey[] }>(`/api/admin/keys/${name}`, { method: "PUT", body: { value } }, value ? t("keySaved") : t("keyRemoved"));
    if (!r) return;
    setFresh(r.keys);
    setDrafts((d) => ({ ...d, [name]: "" }));
  }

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("keysTitle")}</h2>
        <p className="hint">{t("keysHint")}</p>
      </div>
      {!keys ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        (["payments", "suppliers", "telegram", "email", "storage"] as const).map((group) => (
          <div key={group} className="stack-sm">
            <h3 style={{ margin: 0, fontSize: 15 }}>{t(group === "payments" ? "keysPayments" : group === "suppliers" ? "keysSuppliers" : group === "telegram" ? "keysTelegram" : group === "email" ? "keysEmail" : "keysStorage")}</h3>
            {keys.filter((k) => k.group === group).map((k) => {
              const draft = drafts[k.name] ?? "";
              return (
                <div key={k.name} className="stack-sm" style={{ gap: 6 }}>
                  <div className="pref-row">
                    <span>{k.label}</span>
                    {k.source === "admin" ? (
                      <span className="badge badge--good num" dir="ltr">••••{k.hint}</span>
                    ) : k.source === "worker" ? (
                      <span className="badge badge--good">{t("keyInWorker")}</span>
                    ) : (
                      <span className="badge">{t("keyNotSet")}</span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input
                      id={`key-${k.name}`}
                      className="input"
                      dir="ltr"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      style={{ flex: "1 1 220px", minWidth: 0 }}
                      placeholder={k.source ? t("keyReplacePh") : k.name}
                      aria-label={k.label}
                      value={draft}
                      onChange={(e) => setDrafts((d) => ({ ...d, [k.name]: e.target.value.trim() }))}
                    />
                    <button type="button" className="btn btn--sm press" disabled={action.busy || draft === ""} onClick={() => save(k.name, draft)}>
                      {t("save")}
                    </button>
                    {k.source === "admin" && (
                      <button type="button" className="btn btn--sm btn--ghost press" disabled={action.busy} onClick={() => save(k.name, null)}>
                        {t("keyRemove")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
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
          <div className="pref-row">
            <span>{t("staffBot")}</span>
            {s.staffBot?.username ? (
              <a className="badge badge--good" dir="ltr" href={`https://t.me/${s.staffBot.username}`} target="_blank" rel="noopener">@{s.staffBot.username}</a>
            ) : s.staffBot?.error ? (
              <span className="badge badge--warn">{t("botNotConnected")}</span>
            ) : (
              <span className="badge">{t("staffBotSame")}</span>
            )}
          </div>
          {s.staffBot?.error && <p className="hint">{t("botError", { msg: s.staffBot.error })}</p>}
          <p className="hint">{s.staffBot?.username ? t("staffBotStart", { bot: s.staffBot.username }) : t("staffBotHint")}</p>
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
  const [channel, setChannel] = useState("");
  const [stars, setStars] = useState("");
  const [retries, setRetries] = useState("5");
  const [minTopup, setMinTopup] = useState("1");
  const [maxTopup, setMaxTopup] = useState("1000");
  const [mailFrom, setMailFrom] = useState("");
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

  useEffect(() => {
    if (!data) return;
    const p = data.settings["referral.percent"];
    setRefPct(typeof p === "number" ? String(p) : "0");
    const text = (k: string) => (typeof data.settings[k] === "string" ? (data.settings[k] as string) : "");
    setTg(text("support.telegram"));
    setWa(text("support.whatsapp"));
    setEmail(text("support.email"));
    setChannel(text("telegram.channel_url"));
    setMailFrom(text("email.from"));
    const sr = data.settings["payments.stars_per_usd"];
    setStars(typeof sr === "number" ? String(sr) : "");
    const mr = data.settings["numbers.max_retries"];
    setRetries(typeof mr === "number" ? String(mr) : "5");
    const mn = data.settings["payments.min_topup_cents"];
    setMinTopup(typeof mn === "number" ? String(mn / 100) : "1");
    const mx = data.settings["payments.max_topup_cents"];
    setMaxTopup(typeof mx === "number" ? String(mx / 100) : "1000");
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
    if (key === "telegram.channel_url" && cur.telegram) setState({ config: { ...cur, telegram: { ...cur.telegram, channel: value as string | null } } });
    if (key.startsWith("support.")) setState({ config: { ...cur, support: { ...cur.support, [key.slice(8)]: value as string | null } } });
    if (key === "payments.stars_per_usd") setState({ config: { ...cur, payments: { ...cur.payments, starsPerUsd: value as number | null } } });
    if (key === "payments.min_topup_cents") setState({ config: { ...cur, payments: { ...cur.payments, minCents: value as number } } });
    if (key === "payments.max_topup_cents") setState({ config: { ...cur, payments: { ...cur.payments, maxCents: value as number } } });
    if (key === "images.resize") setState({ config: { ...cur, images: { resize: value === true } } });
    applyTheme();
  }

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 240 }} />;
  const preset = (data.settings["theme.preset"] as ThemePreset) ?? "energetic";
  const mode = (data.settings["theme.default_mode"] as "system" | "light" | "dark") ?? "system";
  const darkUi = getState().mode === "dark";

  return (
    <div className="stack">
      <BotCard />
      <KeysCard />
      <AccountsCard />

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
            <span>{t("telegramChannel")}</span>
            <input id="telegram-channel" className="input" dir="ltr" value={channel} placeholder="https://t.me/…" autoComplete="off"
              onChange={(e) => {
                const v = e.target.value.trim();
                // "@name", "t.me/name" and "https://t.me/name" all become https://t.me/name
                setChannel(v === "" ? "" : v.startsWith("@") ? `https://t.me/${v.slice(1)}` : /^(https?:\/\/)?t\.me\//i.test(v) ? `https://t.me/${v.replace(/^(https?:\/\/)?t\.me\//i, "")}` : v);
              }} />
            <span className="hint">{t("telegramChannelHint")}</span>
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
          disabled={action.busy || (tg !== "" && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(tg)) || (wa !== "" && !/^[1-9][0-9]{7,14}$/.test(wa)) || (email !== "" && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/.test(email))
            || (channel !== "" && !/^https:\/\/t\.me\/(\+[A-Za-z0-9_-]{8,64}|[A-Za-z][A-Za-z0-9_]{4,31})$/.test(channel))}
          onClick={async () => {
            await put("telegram.channel_url", channel || null);
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
          <h2>{t("topupLimitsTitle")}</h2>
          <p className="hint">{t("topupLimitsHint")}</p>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>{t("topupMin")}</span>
            <span className="input-wrap">
              <span className="input-wrap__pre muted">$</span>
              <input className="input num" inputMode="decimal" value={minTopup} onChange={(e) => setMinTopup(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))} />
            </span>
          </label>
          <label className="field">
            <span>{t("topupMax")}</span>
            <span className="input-wrap">
              <span className="input-wrap__pre muted">$</span>
              <input className="input num" inputMode="decimal" value={maxTopup} onChange={(e) => setMaxTopup(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))} />
            </span>
          </label>
        </div>
        {(() => {
          const mn = Math.round(Number(minTopup) * 100);
          const mx = Math.round(Number(maxTopup) * 100);
          const ok = mn >= 10 && mn <= 100_000 && mx >= 100 && mx <= 1_000_000 && mx >= mn;
          return (
            <>
              {!ok && <span className="error-text">{t("topupLimitsBad")}</span>}
              <button
                type="button"
                className="btn btn--sm press"
                style={{ alignSelf: "flex-start" }}
                disabled={action.busy || !ok}
                onClick={async () => {
                  await put("payments.min_topup_cents", mn);
                  await put("payments.max_topup_cents", mx);
                }}
              >
                {t("save")}
              </button>
            </>
          );
        })()}
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
          <h2>{t("numbersTitle")}</h2>
          <p className="hint">{t("numbersHint")}</p>
        </div>
        <label className="field">
          <span>{t("numbersRetries")}</span>
          <input className="input num" inputMode="numeric" value={retries} onChange={(e) => setRetries(e.target.value.replace(/\D/g, "").slice(0, 2))} />
        </label>
        <button
          type="button"
          className="btn btn--sm press"
          style={{ alignSelf: "flex-start" }}
          disabled={action.busy || !(Number(retries) >= 1 && Number(retries) <= 20)}
          onClick={() => put("numbers.max_retries", Number(retries))}
        >
          {t("save")}
        </button>
      </section>

      <section className="card card--pad stack-sm">
        <div>
          <h2>{t("emailReceipts")}</h2>
          <p className="hint">{t("emailReceiptsHint")}</p>
        </div>
        <div className="pref-row">
          <span>{t("emailReceiptsOn")}</span>
          <Switch checked={data.settings["email.receipts"] !== false} onChange={(v) => put("email.receipts", v)} label={t("emailReceiptsOn")} />
        </div>
        <label className="field">
          <span>{t("emailFrom")}</span>
          <input className="input" dir="ltr" value={mailFrom} placeholder="GH Store <orders@gh-store.me>" autoComplete="off" onChange={(e) => setMailFrom(e.target.value)} />
        </label>
        <button type="button" className="btn btn--sm press" style={{ alignSelf: "flex-start" }} disabled={action.busy} onClick={() => put("email.from", mailFrom.trim() || null)}>
          {t("save")}
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

      <section className="card card--pad stack-sm">
        <div>
          <h2>{t("websiteLogin")}</h2>
          <p className="hint">{t("websiteLoginHint")}</p>
        </div>
        <div className="pref-row">
          <span>{t("loginEmail")}</span>
          <Switch checked={data.settings["login.email"] !== false} onChange={(v) => put("login.email", v)} label={t("loginEmail")} />
        </div>
        <div className="pref-row">
          <span>{t("loginGoogle")}</span>
          <Switch checked={data.settings["login.google"] === true} onChange={(v) => put("login.google", v)} label={t("loginGoogle")} />
        </div>
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
        <div className="pref-row">
          <span>{t("newOrderAlerts")}</span>
          <Switch checked={data.settings["notify.new_orders"] !== false} onChange={(v) => put("notify.new_orders", v)} label={t("newOrderAlerts")} />
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
        <div>
          <h2>{t("serviceTitle")}</h2>
          <p className="hint">{t("serviceHint")}</p>
        </div>
        <div className="pref-row">
          <span className="stack-xs">
            <span>{t("failedToOwner")}</span>
            <span className="small muted">{t("failedToOwnerHint")}</span>
          </span>
          <Switch checked={data.settings["orders.failed_to_owner"] !== false} onChange={(v) => void put("orders.failed_to_owner", v)} label={t("failedToOwner")} />
        </div>
        <label className="field">
          <span>{t("reviewAsk")}</span>
          <select
            className="select"
            value={String(typeof data.settings["reviews.ask_hours"] === "number" ? data.settings["reviews.ask_hours"] : 3)}
            onChange={(e) => void put("reviews.ask_hours", Number(e.target.value))}
          >
            {[0, 1, 3, 6, 12, 24, 48].map((h) => (
              <option key={h} value={h}>
                {h === 0 ? t("reviewAskOff") : t("reviewAskAfter", { n: h })}
              </option>
            ))}
          </select>
        </label>
        <div className="pref-row">
          <span className="stack-xs">
            <span>{t("imagesResize")}</span>
            <span className="small muted">{t("imagesResizeHint")}</span>
          </span>
          <Switch checked={data.settings["images.resize"] === true} onChange={(v) => void put("images.resize", v)} label={t("imagesResize")} />
        </div>
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
