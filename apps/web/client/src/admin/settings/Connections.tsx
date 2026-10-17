/** Admin → Settings, owner only: the Telegram bot connection and the store's keys. */
import { useState } from "react";
import { useT } from "../../lib/state";
import { useApi } from "../../lib/useApi";
import { Spinner } from "../../ui/kit";
import { ago, useAction } from "../common";

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
export function KeysCard() {
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
export function BotCard() {
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
