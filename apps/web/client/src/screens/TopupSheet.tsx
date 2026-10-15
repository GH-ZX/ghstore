/**
 * Add funds: pick an amount and a method, then follow that method's step.
 *  - ShamCash (SAM): open the invoice, we watch for the payment.
 *  - USDT auto (NOWPayments): send to the shown address, we watch for it.
 *  - USDT manual (BEP20): send the exact amount, paste the transaction hash.
 *  - Telegram Stars: Telegram's own payment sheet (Mini App only).
 * The balance is credited by the server only after the provider confirms.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFail } from "../lib/api";
import { copyText, dollarsToCents, toLatinDigits, usd } from "../lib/format";
import { errorText } from "../lib/i18n";
import { getState, refreshMe, toast, useApp, useT } from "../lib/state";
import { haptic, openExternal, tg } from "../lib/telegram";
import { invalidate } from "../lib/useApi";
import type { CreatedTopup, PaymentAction, PaymentMethod, Topup } from "../lib/types";
import { CheckIcon, MethodMark } from "../ui/icons";
import { Sheet, Spinner } from "../ui/kit";

type Step = "choose" | "pay" | "done";
type Outcome = "paid" | "review" | "pending" | "failed";

const PRESETS = [500, 1000, 2500, 5000];
const getLang = () => getState().lang;

function outcomeOf(status: string): Outcome {
  if (status === "paid") return "paid";
  if (status === "review" || status === "partial") return "review";
  if (status === "failed" || status === "expired" || status === "rejected") return "failed";
  return "pending";
}

export function TopupSheet({ initialCents, paymentId, onClose }: { initialCents: number; paymentId: string | null; onClose: () => void }) {
  const { t, lang } = useT();
  const { config, miniApp } = useApp();
  const methods = (config?.payments.methods ?? []).filter((m) => m !== "stars" || miniApp);
  const min = config?.payments.minCents ?? 100;
  const max = config?.payments.maxCents ?? 100_000;

  const [step, setStep] = useState<Step>(paymentId ? "pay" : "choose");
  const [amountText, setAmountText] = useState(String(Math.min(Math.max(Math.ceil(initialCents / 100), min / 100), max / 100)));
  const [method, setMethod] = useState<PaymentMethod | null>(methods[0] ?? null);
  const [topup, setTopup] = useState<{ id: string; method: PaymentMethod; amountCents: number; action: PaymentAction | null } | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("pending");
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const [tx, setTx] = useState("");
  const [txError, setTxError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  // Latest props without re-running effects when the parent re-renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const tRef = useRef(t);
  tRef.current = t;

  const cents = dollarsToCents(amountText);
  const amountOk = cents !== null && cents >= min && cents <= max;
  // Stars for this amount, rounded up as Telegram's invoice will be.
  const rate = config?.payments.starsPerUsd ?? null;
  const starsFor = rate !== null && cents !== null ? Math.max(1, Math.ceil((cents * rate) / 100)) : null;

  const finish = useCallback((o: Outcome) => {
    if (!alive.current) return;
    setOutcome(o);
    setStep("done");
    setWatching(false);
    haptic(o === "failed" ? "error" : "success");
    invalidate("/api/wallet");
    void refreshMe();
  }, []);

  // Opening an existing top-up (back from the payment page, or from the pending list).
  useEffect(() => {
    if (!paymentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const p = await api<Topup>(`/api/topups/${encodeURIComponent(paymentId)}`);
        if (cancelled || !alive.current) return;
        setTopup({ id: p.id, method: p.method, amountCents: p.amountCents, action: p.action });
        if (p.status === "paid") finish("paid");
        else if (p.status === "failed" || p.status === "expired" || p.status === "rejected") finish("failed");
        else if (p.method === "bep20") {
          if (p.stage === "checking") {
            setTx(p.txHash ?? "");
            setWatching(true);
          } else if (p.stage === "mismatch") {
            setTx(p.txHash ?? "");
            setTxError(tRef.current("txNoMatch"));
          } else if (p.stage !== "await_hash") finish("review");
        } else if (p.status === "review" || p.status === "partial") finish("review");
        else if (p.method !== "stars") setWatching(true);
      } catch (e) {
        if (cancelled) return;
        toast(errorText(getLang(), e instanceof ApiFail ? e.code : "internal"), true);
        onCloseRef.current();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paymentId, finish]);

  // Watch a top-up until the provider confirms, or say we keep checking in the background.
  // Manual USDT also nudges an on-chain re-check every 20 seconds while confirmations build up.
  useEffect(() => {
    if (!watching || !topup) return;
    let n = 0;
    const hash = tx.trim();
    const limit = topup.method === "bep20" ? 30 : 45;
    const timer = setInterval(async () => {
      n++;
      try {
        if (topup.method === "bep20" && hash && n % 4 === 1) {
          await api(`/api/topups/${topup.id}/tx`, { body: { txHash: hash } }).catch(() => {});
        }
        const p = await api<Topup>(`/api/topups/${topup.id}`);
        if (p.status === "paid") return finish("paid");
        if (p.status === "failed" || p.status === "expired" || p.status === "rejected") return finish("failed");
        if (topup.method === "bep20") {
          if (p.stage === "mismatch") {
            setWatching(false);
            setTxError(tRef.current("txNoMatch"));
            return;
          }
          if (p.status === "review" && p.stage !== "checking") return finish("review");
        } else if (p.status === "review" || p.status === "partial") return finish("review");
      } catch {
        /* offline for a moment: keep trying until the limit */
      }
      if (n >= limit) finish(topup.method === "bep20" ? "review" : "pending");
    }, 5000);
    return () => clearInterval(timer);
    // The hash is read once when watching starts (the input is locked while checking).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, topup, finish]);

  async function create() {
    if (!method || !amountOk || cents === null) return;
    setBusy(true);
    try {
      const r = await api<CreatedTopup>("/api/topups", { body: { method, amountCents: cents } });
      setTopup({ id: r.paymentId, method, amountCents: r.amountCents, action: r.action });
      setStep("pay");
      if (r.action.type === "telegram_invoice") payStars(r.action.url, r.paymentId);
      else if (r.action.type === "redirect") openExternal(r.action.url);
      if (method !== "bep20" && method !== "stars") setWatching(true);
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(false);
    }
  }

  function payStars(url: string, id: string) {
    const w = tg();
    if (!w) return;
    w.openInvoice(url, (status) => {
      if (status === "paid") {
        setTopup((cur) => cur ?? { id, method: "stars", amountCents: cents ?? 0, action: null });
        setWatching(true);
      } else if (status === "failed") finish("failed");
    });
  }

  async function submitTx() {
    if (!topup) return;
    const hash = tx.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      setTxError(t("invalidValue"));
      return;
    }
    setTxError(null);
    setBusy(true);
    try {
      const r = await api<{ status: string }>(`/api/topups/${topup.id}/tx`, { body: { txHash: hash } });
      const o = outcomeOf(r.status);
      if (o === "pending") setWatching(true);
      else if (o === "failed") setTxError(t("txNoMatch"));
      else finish(o);
    } catch (e) {
      setTxError(errorText(lang, e instanceof ApiFail ? e.code : "internal"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(v: string) {
    if (await copyText(v)) toast(t("copied"));
  }

  // ───────────── done
  if (step === "done") {
    const ok = outcome === "paid";
    const title = { paid: "topupPaid", review: "topupReview", pending: "topupPending", failed: "topupFailed" } as const;
    const text = { paid: "topupPaidText", review: "topupReviewText", pending: "topupPendingText", failed: "topupFailedText" } as const;
    const color = ok ? "var(--good)" : outcome === "failed" ? "var(--bad)" : "var(--warn)";
    return (
      <Sheet onClose={onClose} label={t(title[outcome])} head={<span />}>
        <div className="done">
          <span className="done__icon pop" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}>
            {ok ? <CheckIcon size={36} /> : outcome === "failed" ? "!" : <Spinner />}
          </span>
          <h2>{t(title[outcome])}</h2>
          <p className="muted">{t(text[outcome], { amount: usd(topup?.amountCents ?? 0) })}</p>
          <button type="button" className="btn btn--block press" onClick={onClose}>
            {t("ok")}
          </button>
        </div>
      </Sheet>
    );
  }

  // ───────────── pay (method-specific step)
  if (step === "pay") {
    const a = topup?.action;
    const m = topup?.method;
    return (
      <Sheet
        onClose={onClose}
        label={t("addFunds")}
        head={
          <div className="wrap">
            <h2>{t("addFunds")}</h2>
            {topup && (
              <span className="num" style={{ fontSize: 21, fontWeight: 700, color: "var(--accent-text)" }}>
                {usd(topup.amountCents)}
              </span>
            )}
          </div>
        }
      >
        {!topup && <Spinner />}
        {topup && m && <p>{m === "bep20" ? t("c_bep20", { amount: a?.type === "address" ? a.amount : "" }) : t(`c_${m}`)}</p>}

        {a?.type === "address" && (
          <div className="stack-sm">
            <span className="small muted">{t("exactAmount")}</span>
            <div className="copy-box">
              <span style={{ fontSize: 18, fontWeight: 700 }}>
                {a.amount} {a.asset}
              </span>
              <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(a.amount)}>
                {t("copy")}
              </button>
            </div>
            <span className="small muted">
              {t("network")}: <b>{a.network}</b>
            </span>
            <span className="small muted">{t("address")}</span>
            <div className="copy-box">
              <span>{a.address}</span>
              <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(a.address)}>
                {t("copy")}
              </button>
            </div>
            {a.memo && (
              <>
                <span className="small muted">{t("memo")}</span>
                <div className="copy-box">
                  <span>{a.memo}</span>
                  <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(a.memo!)}>
                    {t("copy")}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {m === "bep20" && (
          <label className="field">
            <span>{t("txHash")}</span>
            <input className="input" dir="ltr" value={tx} placeholder={t("txHashPh")} onChange={(e) => setTx(toLatinDigits(e.target.value).trim())} aria-invalid={!!txError} autoComplete="off" spellCheck={false} disabled={watching} />
            {txError && <span className="error-text">{txError}</span>}
          </label>
        )}

        {a?.type === "redirect" && (
          <button type="button" className="btn btn--block btn--soft press" onClick={() => openExternal(a.url)}>
            {t("openInvoice")}
          </button>
        )}
        {a?.type === "telegram_invoice" && !watching && (
          <button type="button" className="btn btn--block btn--soft press" onClick={() => payStars(a.url, topup!.id)}>
            {t("b_stars")}
          </button>
        )}
        {a?.type === "instructions" && <p>{lang === "ar" ? a.textAr : a.textEn}</p>}

        {watching && (
          <div className="card card--pad wrap" role="status">
            <Spinner small />
            <span>{m === "bep20" ? t("checkingTx") : t("waitingPayment")}</span>
          </div>
        )}
        {m === "bep20" && !watching && (
          <button type="button" className="btn btn--block press" onClick={submitTx} disabled={busy}>
            {busy ? <Spinner small /> : t("submitTx")}
          </button>
        )}
      </Sheet>
    );
  }

  // ───────────── choose amount and method
  return (
    <Sheet
      onClose={onClose}
      label={t("addFunds")}
      foot={
        <button type="button" className="btn btn--block press" onClick={create} disabled={busy || !amountOk || !method}>
          {busy ? (
            <Spinner small />
          ) : (
            <>
              {method ? t(`b_${method}`) : t("continue")} · <span className="num">{cents !== null ? usd(cents) : "—"}</span>
            </>
          )}
        </button>
      }
    >
      <label className="amount-big">
        <span>$</span>
        <input
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmountText(toLatinDigits(e.target.value).replace(/[^\d.,]/g, ""))}
          aria-label={t("amount")}
          aria-invalid={!amountOk}
          style={{ width: `${Math.max(2, amountText.length) + 0.6}ch` }}
        />
      </label>
      {!amountOk && <span className="error-text" style={{ textAlign: "center" }}>{t("minMax", { min: usd(min), max: usd(max) })}</span>}
      <div className="amounts" role="group" aria-label={t("amount")}>
        {PRESETS.map((p) => (
          <button key={p} type="button" className="press" aria-pressed={cents === p} onClick={() => setAmountText(String(p / 100))}>
            ${p / 100}
          </button>
        ))}
      </div>
      <h3>{t("payWith")}</h3>
      <div className="methods" role="radiogroup" aria-label={t("payWith")}>
        {methods.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} className="method press" onClick={() => setMethod(m)}>
            <MethodMark method={m} />
            <span style={{ fontWeight: 700, fontSize: 14 }}>{t(`m_${m}`)}</span>
            <span className="small muted">
              {m === "stars" && starsFor !== null ? t("starsCount", { n: starsFor.toLocaleString("en-US") }) : t(`m_${m}_sub`)}
            </span>
          </button>
        ))}
      </div>
      {!miniApp && config?.payments.methods.includes("stars") && <span className="hint">{t("starsOnlyInTelegram")}</span>}
    </Sheet>
  );
}
