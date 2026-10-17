/**
 * Admin → Broadcast → Channel posts: what the store posts to its Telegram
 * channel by itself (new products, back in stock, price drops), where, how
 * many a day, a test post, and the latest posts (packages/api/src/channel.ts).
 */
import { useState } from "react";
import { api, ApiFail } from "../lib/api";
import { errorText, pick } from "../lib/i18n";
import { toast, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Spinner, Switch } from "../ui/kit";
import { ago, useAction } from "./common";

interface SettingsData {
  settings: Record<string, unknown>;
}

interface ChannelData {
  chat: string | null;
  posts: { id: string | number; kind: string; status: string; error: string | null; created_at: string; sent_at: string | null; name_ar: string; name_en: string }[];
}

export function ChannelCard() {
  const { t, lang } = useT();
  const action = useAction();
  const settings = useApi<SettingsData>("/api/admin/settings");
  const channel = useApi<ChannelData>("/api/admin/channel");
  const [chat, setChat] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const s = settings.data?.settings ?? {};
  const saved = typeof s["channel.chat"] === "string" ? (s["channel.chat"] as string) : "";
  const chatV = chat ?? saved;
  const chatOk = !chatV || /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{6,15})$/.test(chatV.trim());
  const max = typeof s["channel.max_per_day"] === "number" ? (s["channel.max_per_day"] as number) : 6;

  async function put(key: string, value: unknown) {
    if (await action.run(`/api/admin/settings/${key}`, { method: "PUT", body: { value } })) {
      void settings.reload();
      void channel.reload();
    }
  }

  async function test() {
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; chat?: string; error?: string }>("/api/admin/channel/test", { body: {} });
      toast(r.ok ? t("chanTestSent", { chat: r.chat ?? "" }) : `${t("chanTestFailed")}: ${r.error ?? ""}`, !r.ok);
      void channel.reload();
    } catch (e) {
      const f = e instanceof ApiFail ? e : new ApiFail("internal", 0);
      toast(f.field === "channel.chat" ? t("chanNoChat") : errorText(lang, f.code), true);
    } finally {
      setTesting(false);
    }
  }

  const toggles: [string, string][] = [
    ["channel.post_new", "chanNew"],
    ["channel.post_back", "chanBack"],
    ["channel.post_drops", "chanDrops"],
  ];

  return (
    <section className="card card--pad stack-sm">
      <div>
        <h2>{t("chanTitle")}</h2>
        <p className="hint">{t("chanHint")}</p>
      </div>
      {toggles.map(([key, label]) => (
        <div key={key} className="pref-row">
          <span>{t(label as "chanNew")}</span>
          <Switch checked={s[key] === true} onChange={(v) => void put(key, v)} label={t(label as "chanNew")} />
        </div>
      ))}
      <div className="form-grid">
        <label className="field">
          <span>{t("chanChat")}</span>
          <input className="input" dir="ltr" value={chatV} placeholder={channel.data?.chat ?? "@yourchannel"} aria-invalid={!chatOk} onChange={(e) => setChat(e.target.value.trim())} />
          <span className="small muted">{t("chanChatHint")}</span>
        </label>
        <label className="field">
          <span>{t("chanMax")}</span>
          <select className="select" value={String(max)} onChange={(e) => void put("channel.max_per_day", Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 8, 10, 15, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="wrap" style={{ gap: 8 }}>
        <button type="button" className="btn btn--sm press" disabled={action.busy || !chatOk || chatV === saved} onClick={() => void put("channel.chat", chatV.trim() || null)}>
          {t("save")}
        </button>
        <button type="button" className="btn btn--sm btn--soft press" disabled={testing} onClick={() => void test()}>
          {testing ? <Spinner small /> : t("chanTest")}
        </button>
      </div>
      {channel.data && channel.data.posts.length > 0 && (
        <div className="stack-xs">
          <span className="small muted">{t("chanLatest")}</span>
          {channel.data.posts.slice(0, 8).map((p) => (
            <span key={String(p.id)} className="small row-between">
              <span>
                {t(`chanKind_${p.kind}` as "chanKind_new_product")} · <bdi>{pick(lang, p.name_ar, p.name_en)}</bdi>
              </span>
              <span className={p.status === "failed" ? "error-text" : "muted"} title={p.error ?? ""}>
                {t(`chanSt_${p.status}` as "chanSt_sent")} · {ago(p.sent_at ?? p.created_at, lang)}
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
