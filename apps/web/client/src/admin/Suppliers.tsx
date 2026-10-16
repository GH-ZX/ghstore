/**
 * Suppliers: one card per supplier with what matters at a glance (working or
 * not, balance, what sells, what waits for you) and its actions: choose what
 * to sell (Choose.tsx), check prices now, review paused packages, and
 * settings. API keys live in Settings → Keys.
 */
import { useState } from "react";
import { dollarsToCents, toLatinDigits, usd } from "../lib/format";
import { api, ApiFail } from "../lib/api";
import { errorText, pick } from "../lib/i18n";
import { linkHandler, usePath } from "../lib/router";
import { toast, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Empty, ErrorBox, Sheet, Spinner, Switch } from "../ui/kit";
import { Choose } from "./Choose";
import { ago, useAction } from "./common";

interface Report {
  at: string;
  checked: number;
  repriced: number;
  paused: number;
  resumed: number;
  missing: number;
  review?: number;
  complete: boolean;
  error?: string;
}

interface Sup {
  id: string;
  name: string;
  enabled: boolean;
  health: "ok" | "degraded" | "down" | "unknown";
  lastError: string | null;
  balanceCents: number | null;
  lowBalanceCents: number;
  lastSyncAt: string | null;
  syncMinutes: number;
  autoReprice: boolean;
  maxJumpPct: number | null;
  importMarkupPct: number;
  importMinMarginPct: number;
  importRoundToCents: number;
  importCategoryId: string | null;
  importDescriptionAr: string;
  importDescriptionEn: string;
  lastReport: Report | null;
  counts: { packages: number; selling: number; unavailable: number; belowMargin: number; costJump: number; pausedByStaff: number; notChecked: number };
}

type T = ReturnType<typeof useT>["t"];

/** Supplier errors in words an owner can act on; the raw text stays underneath. */
function plainError(t: T, raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("too many subrequests")) return t("supErrTooMany");
  if (/\b(401|403)\b|unauthor|forbidden|invalid api key|api key/.test(s)) return t("supErrKey");
  if (s.includes("not configured")) return t("supErrNoKey");
  if (s.includes("application not found") || /\b404\b/.test(s)) return t("supErrAddress");
  if (/\b(5\d\d)\b|server error|timed out|timeout/.test(s)) return t("supErrDown");
  if (s.includes("network")) return t("supErrNetwork");
  return t("supErrOther");
}

const EVERY = [15, 30, 60, 180, 360, 720, 1440];
const JUMPS = [20, 30, 50, 100, 200];
const ROUNDS = [1, 5, 10, 25, 50, 100];

function everyLabel(t: T, m: number): string {
  return m < 60 ? t("everyMin", { n: m }) : m === 60 ? t("everyHour") : t("everyHours", { n: m / 60 });
}

interface Cat {
  id: string;
  name_ar: string;
  name_en: string;
}

export function Suppliers() {
  const path = usePath();
  const choose = /^\/admin\/suppliers\/choose\/([a-z0-9_]{2,32})$/.exec(path);
  if (choose) return <Choose supplierId={choose[1]!} />;
  return <SupplierList />;
}

function SupplierList() {
  const { t } = useT();
  const { data, error, reload } = useApi<{ suppliers: Sup[]; categories: Cat[] }>("/api/admin/suppliers");
  const [settings, setSettings] = useState<Sup | null>(null);
  const [review, setReview] = useState<Sup | null>(null);

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 320 }} />;
  return (
    <div className="stack">
      <p className="hint">{t("suppliersHint")}</p>
      <div className="sup-grid">
        {data.suppliers.map((s) => (
          <SupplierCard key={s.id} s={s} onChanged={reload} onSettings={() => setSettings(s)} onReview={() => setReview(s)} />
        ))}
      </div>
      {settings && (
        <SettingsSheet
          s={settings}
          categories={data.categories}
          onClose={(changed) => {
            setSettings(null);
            if (changed) void reload();
          }}
        />
      )}
      {review && (
        <ReviewSheet
          s={review}
          onClose={() => {
            setReview(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function SupplierCard({ s, onChanged, onSettings, onReview }: { s: Sup; onChanged: () => void; onSettings: () => void; onReview: () => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const c = s.counts;
  const toReview = c.costJump + c.belowMargin;
  const paused = c.unavailable + c.pausedByStaff;
  const low = s.balanceCents !== null && s.lowBalanceCents > 0 && s.balanceCents < s.lowBalanceCents;
  const r = s.lastReport;

  const status = !s.enabled
    ? { cls: "badge", text: t("supOff") }
    : s.health === "ok"
      ? { cls: "badge badge--good", text: t("supWorking") }
      : s.health === "unknown"
        ? { cls: "badge", text: t("supNotChecked") }
        : { cls: "badge badge--bad", text: t("supProblem") };

  async function toggle(v: boolean) {
    if (await action.run(`/api/admin/suppliers/${s.id}`, { method: "PATCH", body: { enabled: v } }, v ? t("supTurnedOn") : t("supTurnedOff"))) onChanged();
  }

  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try {
      const rep = await api<Report>(`/api/admin/suppliers/${s.id}/sync`, { method: "POST", body: {} });
      if (rep.error) toast(`${t("supCheckFailed")}: ${plainError(t, rep.error)}`, true);
      else {
        const review = rep.review ? ` · ${t("supReviewN", { n: rep.review })}` : "";
        toast(`${t("supChecked", { checked: rep.checked, repriced: rep.repriced, paused: rep.paused })}${review}${rep.complete ? "" : ` · ${t("supMoreLater")}`}`);
      }
      onChanged();
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setChecking(false);
    }
  }

  // What the last check did, in one line.
  let lastLine: string;
  if (!r) lastLine = s.lastSyncAt ? t("supLastCheckAt", { when: ago(s.lastSyncAt, lang) }) : t("supNeverChecked");
  else if (r.error) lastLine = t("supLastFailed", { when: ago(r.at, lang) });
  else
    lastLine = t("supLastResult", {
      when: ago(r.at, lang),
      checked: r.checked,
      repriced: r.repriced,
      paused: r.paused,
    });

  return (
    <section className="card card--pad stack-sm sup">
      <div className="row-between">
        <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
          <h3>{s.name}</h3>
          <span className={status.cls} style={{ alignSelf: "flex-start" }}>{status.text}</span>
        </div>
        <Switch checked={s.enabled} onChange={toggle} label={t("enabled")} />
      </div>

      {s.enabled && s.lastError && (
        <div className="sup__alert">
          <strong>{plainError(t, s.lastError)}</strong>
          <span className="small muted num" dir="ltr">{s.lastError}</span>
        </div>
      )}

      <div className="sup__stats">
        <div className={low ? "sup__stat sup__stat--warn" : "sup__stat"}>
          <span className="small muted">{t("balance")}</span>
          <span className="num">{s.balanceCents === null ? "—" : usd(s.balanceCents)}</span>
          {low && <span className="small warn">{t("supLow")}</span>}
        </div>
        <div className="sup__stat">
          <span className="small muted">{t("supSelling")}</span>
          <span className="num">
            {c.selling}
            <span className="muted"> / {c.packages}</span>
          </span>
        </div>
        <button type="button" className={toReview > 0 ? "sup__stat sup__stat--warn press" : "sup__stat press"} onClick={onReview} disabled={toReview + paused === 0}>
          <span className="small muted">{t("supToReview")}</span>
          <span className="num">{toReview}</span>
          {paused > 0 && <span className="small muted">{t("supAlsoPaused", { n: paused })}</span>}
        </button>
      </div>

      <div className="stack-sm" style={{ gap: 2 }}>
        <span className="small">{lastLine}</span>
        {r && !r.complete && !r.error && <span className="small muted">{t("supContinues", { n: c.notChecked })}</span>}
        <span className="small muted">
          {everyLabel(t, s.syncMinutes)} · {s.autoReprice ? t("supAutoOn") : t("supAutoOff")}
          {s.maxJumpPct !== null ? ` · ${t("supGuard", { n: s.maxJumpPct })}` : ""}
        </span>
      </div>

      <div className="wrap">
        <a className="btn btn--sm press" href={`/admin/suppliers/choose/${s.id}`} onClick={linkHandler(`/admin/suppliers/choose/${s.id}`)}>
          {t("choosePackages")}
        </a>
        <button type="button" className="btn btn--sm btn--soft press" disabled={checking || !s.enabled} onClick={check}>
          {checking ? <Spinner small /> : t("supCheckNow")}
        </button>
        <button type="button" className="btn btn--sm btn--ghost press" onClick={onSettings}>
          {t("settings")}
        </button>
      </div>
    </section>
  );
}

function SettingsSheet({ s, categories, onClose }: { s: Sup; categories: Cat[]; onClose: (changed: boolean) => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const [every, setEvery] = useState(s.syncMinutes);
  const [auto, setAuto] = useState(s.autoReprice);
  const [jump, setJump] = useState<number | null>(s.maxJumpPct);
  const [low, setLow] = useState((s.lowBalanceCents / 100).toFixed(2));
  const [markup, setMarkup] = useState(String(s.importMarkupPct));
  const [margin, setMargin] = useState(String(s.importMinMarginPct));
  const [round, setRound] = useState(s.importRoundToCents);
  const [category, setCategory] = useState(s.importCategoryId ?? "");
  const [descAr, setDescAr] = useState(s.importDescriptionAr);
  const [descEn, setDescEn] = useState(s.importDescriptionEn);

  const lowCents = dollarsToCents(low);
  const markupN = Number(toLatinDigits(markup));
  const marginN = Number(toLatinDigits(margin));
  const ok = lowCents !== null && Number.isFinite(markupN) && markupN >= 0 && markupN <= 1000 && Number.isFinite(marginN) && marginN >= 0 && marginN <= 500;

  async function save() {
    if (!ok) return;
    const body = {
      syncMinutes: every,
      autoReprice: auto,
      maxJumpPct: jump,
      lowBalanceCents: lowCents,
      importMarkupPct: Math.round(markupN * 100) / 100,
      importMinMarginPct: Math.round(marginN * 100) / 100,
      importRoundToCents: round,
      importCategoryId: category || null,
      importDescriptionAr: descAr,
      importDescriptionEn: descEn,
    };
    if (await action.run(`/api/admin/suppliers/${s.id}`, { method: "PATCH", body })) onClose(true);
  }

  const digits = (v: string) => toLatinDigits(v).replace(/[^\d.]/g, "");
  return (
    <Sheet
      onClose={() => onClose(false)}
      label={`${s.name} · ${t("settings")}`}
      foot={
        <button type="button" className="btn btn--block press" disabled={!ok || action.busy} onClick={save}>
          {action.busy ? <Spinner small /> : t("save")}
        </button>
      }
    >
      <h3>{t("supPrices")}</h3>
      <label className="field">
        <span>{t("supEvery")}</span>
        <select className="select" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
          {EVERY.map((m) => (
            <option key={m} value={m}>
              {everyLabel(t, m)}
            </option>
          ))}
        </select>
      </label>
      <div className="pref-row">
        <span className="stack-sm" style={{ gap: 2 }}>
          <span>{t("supAutoLabel")}</span>
          <span className="hint">{auto ? t("supAutoHintOn") : t("supAutoHintOff")}</span>
        </span>
        <Switch checked={auto} onChange={setAuto} label={t("supAutoLabel")} />
      </div>
      <label className="field">
        <span>{t("supGuardLabel")}</span>
        <select className="select" value={jump === null ? "off" : String(jump)} onChange={(e) => setJump(e.target.value === "off" ? null : Number(e.target.value))}>
          <option value="off">{t("supGuardOff")}</option>
          {JUMPS.map((j) => (
            <option key={j} value={j}>
              {t("supGuardOption", { n: j })}
            </option>
          ))}
        </select>
        <span className="hint">{t("supGuardHint")}</span>
      </label>

      <h3>{t("balance")}</h3>
      <label className="field">
        <span>{t("lowBalanceAt")}</span>
        <input className="input num" inputMode="decimal" value={low} onChange={(e) => setLow(digits(e.target.value))} />
        <span className="hint">{t("supLowHint")}</span>
      </label>

      <h3>{t("supImportDefaults")}</h3>
      <p className="hint">{t("supImportHint")}</p>
      <div className="form-grid">
        <label className="field">
          <span>{t("supMarkup")}</span>
          <input className="input num" inputMode="decimal" value={markup} onChange={(e) => setMarkup(digits(e.target.value))} />
        </label>
        <label className="field">
          <span>{t("supMinMargin")}</span>
          <input className="input num" inputMode="decimal" value={margin} onChange={(e) => setMargin(digits(e.target.value))} />
        </label>
        <label className="field">
          <span>{t("supRound")}</span>
          <select className="select" value={round} onChange={(e) => setRound(Number(e.target.value))}>
            {ROUNDS.map((r) => (
              <option key={r} value={r}>
                {r === 1 ? t("supRoundNone") : usd(r)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3>{t("supNewProducts")}</h3>
      <p className="hint">{t("supNewProductsHint")}</p>
      <label className="field">
        <span>{t("supNewCategory")}</span>
        <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t("supNewCategoryFirst")}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {pick(lang, c.name_ar, c.name_en)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t("descriptionAr")}</span>
        <textarea className="textarea" dir="rtl" rows={4} maxLength={4000} value={descAr} onChange={(e) => setDescAr(e.target.value)} />
      </label>
      <label className="field">
        <span>{t("descriptionEn")}</span>
        <textarea className="textarea" dir="ltr" rows={4} maxLength={4000} value={descEn} onChange={(e) => setDescEn(e.target.value)} />
        <span className="hint">{t("supDescHint")}</span>
      </label>
    </Sheet>
  );
}

interface ReviewItem {
  id: string;
  supplierRef: string;
  nameAr: string;
  nameEn: string;
  productAr: string;
  productEn: string;
  reason: string;
  costCents: number | null;
  pendingCostCents: number | null;
  priceCents: number;
}

const REASONS = ["cost_jump", "cost_above_margin", "supplier_unavailable", "other"] as const;

function ReviewSheet({ s, onClose }: { s: Sup; onClose: () => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const { data, error, reload } = useApi<{ packages: ReviewItem[] }>(`/api/admin/suppliers/${s.id}/review`);

  async function accept(i: ReviewItem) {
    if (await action.run(`/api/admin/offers/${i.id}/accept-cost`, {}, t("supAccepted"))) void reload();
  }

  const groups = REASONS.map((reason) => ({
    reason,
    items: (data?.packages ?? []).filter((i) => (reason === "other" ? !REASONS.includes(i.reason as never) : i.reason === reason)),
  })).filter((g) => g.items.length > 0);

  return (
    <Sheet onClose={onClose} label={`${s.name} · ${t("supReview")}`}>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <Spinner />}
      {data && groups.length === 0 && <Empty>{t("supNothingToReview")}</Empty>}
      {groups.map((g) => (
        <div key={g.reason} className="stack-sm">
          <h3>
            {t(`supWhy_${g.reason}`)} <span className="muted num">({g.items.length})</span>
          </h3>
          <p className="hint">{t(`supWhyHint_${g.reason}`)}</p>
          <div className="list">
            {g.items.map((i) => {
              const change =
                i.costCents !== null && i.pendingCostCents !== null && i.costCents > 0
                  ? Math.round(((i.pendingCostCents - i.costCents) * 100) / i.costCents)
                  : null;
              return (
                <div key={i.id} className="list-row">
                  <span className="list-row__main">
                    <span className="list-row__title">
                      {pick(lang, i.productAr, i.productEn)} · {pick(lang, i.nameAr, i.nameEn)}
                    </span>
                    <span className="list-row__meta num">
                      #{i.supplierRef} · {t("cost")} {i.costCents === null ? "—" : usd(i.costCents)}
                      {i.pendingCostCents !== null && ` → ${usd(i.pendingCostCents)}${change !== null ? ` (${change > 0 ? "+" : ""}${change}%)` : ""}`} · {t("price")} {usd(i.priceCents)}
                    </span>
                  </span>
                  {i.reason === "cost_jump" && i.pendingCostCents !== null && (
                    <button type="button" className="btn btn--xs press" disabled={action.busy} onClick={() => accept(i)}>
                      {t("supAccept")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Sheet>
  );
}
