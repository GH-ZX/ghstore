/** Wallet: balance, add funds, recent activity and top-ups waiting for payment. */
import { useCallback, useState } from "react";
import { dateTime, signedUsd, usd, syp } from "../lib/format";
import { pick } from "../lib/i18n";
import { back, navigate, useQuery } from "../lib/router";
import { useApp, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import type { Wallet as WalletData, WalletEntry } from "../lib/types";
import { ArrowInIcon, ArrowOutIcon, PlusIcon } from "../ui/icons";
import { Empty, ErrorBox } from "../ui/kit";
import { Shell } from "../ui/Shell";
import { RequireUser } from "./Login";
import { TopupSheet } from "./TopupSheet";

type Filter = "all" | "topup" | "purchase";

export function Wallet() {
  const { t } = useT();
  return (
    <Shell title={t("wallet")} narrow>
      <RequireUser>
        <WalletView />
      </RequireUser>
    </Shell>
  );
}

function WalletView() {
  const { t, lang } = useT();
  const { me, config } = useApp();
  const query = useQuery();
  const [filter, setFilter] = useState<Filter>("all");
  const path = filter === "all" ? "/api/wallet" : `/api/wallet?kind=${filter}`;
  const { data, error, loading, reload } = useApi<WalletData>(path);
  const topupParam = query.get("topup");
  const paymentParam = query.get("payment");
  const balance = data?.balanceCents ?? me?.balanceCents ?? 0;
  const s = syp(balance, config?.sypPerUsd, lang);

  const closeSheet = useCallback(() => {
    back("/wallet");
    void reload();
  }, [reload]);

  return (
    <>
    <div className="stack screen" style={{ gap: 18 }}>
      <div className="stack-sm" style={{ gap: 2 }}>
        <span className="small muted">{t("yourBalance")}</span>
        <span className="balance">{usd(balance)}</span>
        {s && <span className="small muted">≈ {s}</span>}
      </div>
      <button type="button" className="btn btn--block press" onClick={() => navigate("/wallet?topup=1000")}>
        <PlusIcon />
        {t("addFunds")}
      </button>

      {data && data.pending.length > 0 && (
        <div className="stack-sm">
          <h3>{t("pendingTopups")}</h3>
          <div className="list">
            {data.pending.map((p) => (
              <button key={p.id} type="button" className="list-row press" onClick={() => navigate(`/wallet?payment=${p.id}`)}>
                <span className="round-icon" style={{ color: "var(--warn)" }}>
                  <ArrowInIcon />
                </span>
                <span className="list-row__main">
                  <span className="list-row__title">{t(`m_${p.method}`)}</span>
                  <span className="list-row__meta">{dateTime(p.createdAt, lang)}</span>
                </span>
                <span className="list-row__end">
                  <span className="num" style={{ fontWeight: 700 }}>
                    {usd(p.amountCents)}
                  </span>
                  <span className="small warn">{p.status === "review" ? t("topupReview") : t("pendingTopups")}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="row-between">
        <h3>{t("recent")}</h3>
        <div className="wrap" role="group" aria-label={t("recent")}>
          {(["all", "topup", "purchase"] as const).map((f) => (
            <button key={f} type="button" className="chip chip--sm press" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(f === "all" ? "fAll" : f === "topup" ? "fTop" : "fBuy")}
            </button>
          ))}
        </div>
      </div>
      {loading && !data && <div className="skeleton" style={{ height: 200 }} />}
      <ErrorBox error={data ? null : error} onRetry={reload} />
      {data && data.entries.length === 0 && <Empty>{t("noActivity")}</Empty>}
      {data && data.entries.length > 0 && (
        <div className="list">
          {data.entries.map((e) => (
            <EntryRow key={e.id} e={e} />
          ))}
        </div>
      )}

    </div>
    {/* Outside the animated .screen box, so the fixed sheet is placed against the viewport at once. */}
    {(topupParam || paymentParam) && <TopupSheet initialCents={Number(topupParam) || 1000} paymentId={paymentParam} onClose={closeSheet} />}
    </>
  );
}

function EntryRow({ e }: { e: WalletEntry }) {
  const { t, lang } = useT();
  const incoming = e.amountCents > 0;
  const title =
    e.kind === "topup" && e.method ? t(`m_${e.method}`) : e.kind === "adjustment" ? e.note ?? t("t_adjustment") : pick(lang, e.productAr, e.productEn) || t(`t_${e.kind}`);
  return (
    <div className="list-row">
      <span className="round-icon" style={{ color: incoming ? "var(--good)" : "var(--ink)" }}>
        {incoming ? <ArrowInIcon /> : <ArrowOutIcon />}
      </span>
      <span className="list-row__main">
        <span className="list-row__title">{title}</span>
        <span className="list-row__meta">
          {t(`t_${e.kind}`)} · {dateTime(e.createdAt, lang)}
        </span>
      </span>
      <span className="num" style={{ fontWeight: 700, color: incoming ? "var(--good)" : "var(--ink)" }}>
        {signedUsd(e.amountCents)}
      </span>
    </div>
  );
}
