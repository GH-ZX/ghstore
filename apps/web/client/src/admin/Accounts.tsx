/**
 * Admin → Settings → APIs: each supplier's and payment provider's account as
 * the provider describes it, read when the owner opens it: a wallet card (the
 * balance, one currency at a time), the latest transfers as in the provider's
 * own app (ShamCash's look, in the store's colours), then the account details.
 */
import { useState } from "react";
import { api, ApiFail } from "../lib/api";
import { dateTime } from "../lib/format";
import { errorText, type MsgKey } from "../lib/i18n";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { ChevronIcon, MethodMark } from "../ui/icons";
import { ErrorBox, Spinner } from "../ui/kit";

interface Account {
  kind: "supplier" | "payment";
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  readable: boolean;
}

interface AccountInfo {
  fields: { label: string; value: string }[];
  balances: { currency: string; amount: number }[];
  history: { at: string | null; amount: number; currency: string; text: string; direction: "in" | "out" | null; ref?: string | null; note?: string | null }[];
}

/** Currency names for the wallet card's switch (others show their code). */
const CURRENCY_NAMES: Partial<Record<string, MsgKey>> = { SYP: "curSyp", USD: "curUsd" };

/** "SYP 4,416.15", as the providers' apps write it (numbers left to right). */
const walletAmount = (amount: number, currency: string) =>
  `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(amount) < 1 && amount !== 0 ? 4 : 2 })}`;

const money = (amount: number, currency: string) => {
  const digits = currency === "SYP" ? 0 : Math.abs(amount) < 1 && amount !== 0 ? 4 : 2;
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: digits === 4 ? 2 : digits, maximumFractionDigits: digits })} ${currency}`;
};

export function AccountsCard() {
  const { t } = useT();
  const { data, error, reload } = useApi<{ accounts: Account[] }>("/api/admin/accounts");
  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("apisTitle")}</h2>
        <p className="hint">{t("apisHint")}</p>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 120 }} />}
      {data && (
        <div className="accounts">
          {data.accounts.map((a) => (
            <AccountRow key={`${a.kind}:${a.id}`} a={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function AccountRow({ a }: { a: Account }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ info?: AccountInfo; error?: string }>(`/api/admin/accounts/${a.kind}/${a.id}`);
      if (r.error) setProblem(r.error);
      else setInfo(r.info ?? null);
    } catch (e) {
      setProblem(errorText(lang, e instanceof ApiFail ? e.code : "internal"));
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !info) void load();
  }

  const state = !a.configured ? t("apiNoKey") : !a.enabled ? t("apiOff") : t("apiReady");
  return (
    <div className={`account${open ? " account--open" : ""}`}>
      <button type="button" className="account__head press" disabled={!a.readable} onClick={toggle} aria-expanded={open}>
        {a.kind === "payment" && a.id === "sam" ? (
          <MethodMark method="sam" size={30} />
        ) : (
          <span className="dot" style={{ background: !a.configured ? "var(--muted)" : a.enabled ? "var(--good)" : "var(--warn)" }} />
        )}
        <span className="account__name">
          <strong>{a.name}</strong>
          <span className="small muted">
            {a.kind === "payment" ? t("apiPayment") : t("apiSupplier")} · {state}
          </span>
        </span>
        {info?.balances[0] && <span className="num account__balance">{money(info.balances[0].amount, info.balances[0].currency)}</span>}
        {a.readable && (
          <span className="account__chev">
            <ChevronIcon />
          </span>
        )}
      </button>
      {open && (
        <div className="account__body stack-sm">
          {busy && <Spinner small />}
          {problem && <p className="small bad">{problem}</p>}
          {info && (
            <>
              {info.balances.length > 0 && (() => {
                const shown = info.balances.find((b) => b.currency === currency) ?? info.balances[0]!;
                return (
                  <div className="wallet-card">
                    <div className="row-between">
                      {a.kind === "payment" && a.id === "sam" ? <MethodMark method="sam" size={38} /> : <span />}
                      {info.balances.length > 1 && (
                        <div className="seg seg--on-card" role="group" aria-label={t("apiCurrency")}>
                          {info.balances.map((b) => (
                            <button key={b.currency} type="button" className="press" aria-pressed={b.currency === shown.currency} onClick={() => setCurrency(b.currency)}>
                              {CURRENCY_NAMES[b.currency] ? t(CURRENCY_NAMES[b.currency]!) : b.currency}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="wallet-card__label">{t("apiTotalBalance")}</span>
                    <strong className="wallet-card__amount" dir="ltr">
                      {walletAmount(shown.amount, shown.currency)}
                    </strong>
                  </div>
                );
              })()}
              {info.history.length > 0 && (
                <div className="stack-sm">
                  <span className="small muted">{t("apiHistory")}</span>
                  <div className="transfers">
                    {info.history.map((h, i) => (
                      <div key={i} className="transfer">
                        <div className="transfer__top">
                          <span className="transfer__who" dir="auto">
                            {h.text}
                          </span>
                          <span className={h.direction === "in" ? "transfer__amount transfer__amount--in" : h.direction === "out" ? "transfer__amount transfer__amount--out" : "transfer__amount"} dir="ltr">
                            {h.direction === "in" ? "+ " : h.direction === "out" ? "− " : ""}
                            {money(Math.abs(h.amount), h.currency)}
                          </span>
                        </div>
                        <div className="transfer__meta">
                          <span dir="auto">{h.note ?? ""}</span>
                          <span dir="ltr">
                            {h.ref ? `#${h.ref}` : ""}
                            {h.ref && h.at ? " · " : ""}
                            {h.at ? dateTime(h.at, lang) : ""}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {info.fields.length > 0 && (
                <dl className="facts">
                  {info.fields.map((f, i) => (
                    <div key={i}>
                      <dt>{f.label}</dt>
                      <dd dir="auto">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {info.fields.length === 0 && info.balances.length === 0 && info.history.length === 0 && <p className="small muted">{t("none")}</p>}
              <button type="button" className="btn btn--xs btn--ghost press" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void load()}>
                {t("apiRefresh")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
