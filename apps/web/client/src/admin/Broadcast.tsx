/** Broadcast: one Telegram message to every customer or to a product's buyers. Owner only. */
import { useState } from "react";
import { dateTime } from "../lib/format";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Empty, ErrorBox, Seg, Sheet, Spinner } from "../ui/kit";
import { useAction } from "./common";

interface ProductLite {
  id: string;
  name_ar: string;
  name_en: string;
}

interface BroadcastItem {
  id: string;
  textAr: string;
  textEn: string;
  audience: "all" | "buyers";
  productAr: string | null;
  productEn: string | null;
  recipients: number;
  createdAt: string;
  cancelledAt: string | null;
  sent: number;
  skipped: number;
  failed: number;
  pending: number;
}

const MAX = 1000;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function Broadcast() {
  const { t, lang } = useT();
  const action = useAction();
  const history = useApi<{ broadcasts: BroadcastItem[] }>("/api/admin/broadcasts");
  const catalog = useApi<{ products: ProductLite[] }>("/api/admin/catalog");
  const [audience, setAudience] = useState<"all" | "buyers">("all");
  const [productId, setProductId] = useState("");
  const [button, setButton] = useState<"store" | "product">("store");
  const [textAr, setTextAr] = useState("");
  const [textEn, setTextEn] = useState("");
  const [key, setKey] = useState(newKey);
  const [confirming, setConfirming] = useState(false);

  const needsProduct = audience === "buyers" || button === "product";
  const audiencePath = audience === "buyers" ? (productId ? `/api/admin/broadcasts/audience?productId=${productId}` : null) : "/api/admin/broadcasts/audience";
  const reach = useApi<{ recipients: number }>(audiencePath);
  const recipients = reach.data?.recipients ?? 0;
  const hasText = textAr.trim().length > 0 || textEn.trim().length > 0;
  const ok = hasText && textAr.length <= MAX && textEn.length <= MAX && (!needsProduct || productId !== "");

  const body = () => ({
    textAr,
    textEn,
    audience,
    button,
    productId: needsProduct ? productId : undefined,
  });

  async function test() {
    await action.run("/api/admin/broadcasts/test", { body: body() }, t("testSent"));
  }

  async function send() {
    const r = await action.run("/api/admin/broadcasts", { body: { ...body(), idempotencyKey: key } }, t("broadcastSent"));
    if (!r) return;
    setConfirming(false);
    setTextAr("");
    setTextEn("");
    setKey(newKey());
    void history.reload();
  }

  async function stop(b: BroadcastItem) {
    await action.run(`/api/admin/broadcasts/${b.id}/cancel`, {}, t("stopped"));
    void history.reload();
  }

  return (
    <div className="stack">
      <p className="hint">{t("broadcastHint")}</p>
      <div className="pref-row">
        <span>{t("audience")}</span>
        <Seg
          label={t("audience")}
          value={audience}
          onChange={setAudience}
          options={[
            { value: "all", label: t("audienceAll") },
            { value: "buyers", label: t("audienceBuyers") },
          ]}
        />
      </div>
      <div className="pref-row">
        <span>{t("buttonOpens")}</span>
        <Seg
          label={t("buttonOpens")}
          value={button}
          onChange={setButton}
          options={[
            { value: "store", label: t("btnStore") },
            { value: "product", label: t("btnProduct") },
          ]}
        />
      </div>
      {needsProduct && (
        <label className="field">
          <span>{t("product")}</span>
          <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{t("chooseProduct")}</option>
            {(catalog.data?.products ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {pick(lang, p.name_ar, p.name_en)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>
          {t("messageAr")} <span className="muted num">{textAr.length}/{MAX}</span>
        </span>
        <textarea className="textarea" dir="rtl" rows={5} maxLength={MAX} value={textAr} onChange={(e) => setTextAr(e.target.value)} />
      </label>
      <label className="field">
        <span>
          {t("messageEn")} <span className="muted num">{textEn.length}/{MAX}</span>
        </span>
        <textarea className="textarea" dir="ltr" rows={5} maxLength={MAX} value={textEn} onChange={(e) => setTextEn(e.target.value)} />
      </label>
      <p className="small muted">{t("messageFallback")}</p>
      <p className="small">{audiencePath ? (reach.data ? t("reaches", { n: recipients }) : "…") : ""}</p>
      <div className="wrap">
        <button type="button" className="btn btn--sm btn--ghost press" disabled={!ok || action.busy} onClick={test}>
          {t("sendTest")}
        </button>
        <button type="button" className="btn btn--sm press" disabled={!ok || action.busy || recipients === 0} onClick={() => setConfirming(true)}>
          {t("sendBroadcast", { n: recipients })}
        </button>
      </div>

      <h3>{t("pastBroadcasts")}</h3>
      <ErrorBox error={history.error} onRetry={history.reload} />
      {!history.data && !history.error && <div className="skeleton" style={{ height: 120 }} />}
      {history.data && history.data.broadcasts.length === 0 && <Empty>{t("none")}</Empty>}
      {history.data && history.data.broadcasts.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("created")}</th>
                <th>{t("message")}</th>
                <th>{t("audience")}</th>
                <th>{t("bcSent")}</th>
                <th>{t("bcPending")}</th>
                <th>{t("bcFailed")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.data.broadcasts.map((b) => (
                <tr key={b.id} style={{ opacity: b.cancelledAt ? 0.6 : 1 }}>
                  <td className="small">{dateTime(b.createdAt, lang)}</td>
                  <td className="wrap-cell small">{(lang === "ar" ? b.textAr : b.textEn).slice(0, 120)}</td>
                  <td className="small">{b.audience === "all" ? t("audienceAll") : pick(lang, b.productAr, b.productEn)}</td>
                  <td className="num">
                    {b.sent} / {b.recipients}
                    {b.skipped > 0 && <span className="muted"> · {t("bcSkipped")} {b.skipped}</span>}
                  </td>
                  <td className="num">{b.pending}</td>
                  <td className="num">{b.failed}</td>
                  <td>
                    {b.cancelledAt ? (
                      <span className="badge">{t("stopped")}</span>
                    ) : b.pending > 0 ? (
                      <button type="button" className="btn btn--xs btn--danger press" disabled={action.busy} onClick={() => stop(b)}>
                        {t("stopBroadcast")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming && (
        <Sheet
          onClose={() => setConfirming(false)}
          label={t("broadcast")}
          foot={
            <button type="button" className="btn btn--block press" disabled={action.busy} onClick={send}>
              {action.busy ? <Spinner small /> : t("sendBroadcast", { n: recipients })}
            </button>
          }
        >
          <p>{t("confirmBroadcast", { n: recipients })}</p>
          <div className="card card--pad" style={{ whiteSpace: "pre-wrap" }} dir={lang === "ar" ? "rtl" : "ltr"}>
            {lang === "ar" ? textAr || textEn : textEn || textAr}
          </div>
        </Sheet>
      )}
    </div>
  );
}
