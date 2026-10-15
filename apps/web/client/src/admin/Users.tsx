/** Users: find a customer, adjust a wallet (owner), change role or block (owner). */
import { useDeferredValue, useState } from "react";
import { idempotencyKey } from "../lib/api";
import { dollarsToCents, usd } from "../lib/format";
import { useApp, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Empty, ErrorBox, Sheet, Spinner } from "../ui/kit";
import { ago, useAction } from "./common";

interface U {
  id: string;
  name: string;
  role: "customer" | "support" | "owner";
  status: "active" | "banned";
  createdAt: string;
  lastSeenAt: string | null;
  balanceCents: number;
  telegramUsername: string | null;
  telegramId: string | null;
  email: string | null;
  orders: number;
}

export function Users({ owner }: { owner: boolean }) {
  const { t, lang } = useT();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const { data, error, reload } = useApi<{ users: U[] }>(`/api/admin/users?q=${encodeURIComponent(query)}`);
  const [open, setOpen] = useState<U | null>(null);
  return (
    <div className="stack">
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchUsers")} />
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 240 }} />}
      {data && data.users.length === 0 && <Empty>{t("none")}</Empty>}
      {data && data.users.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("user")}</th>
                <th>Telegram / email</th>
                <th>{t("balance")}</th>
                <th>{t("orders")}</th>
                <th>{t("role")}</th>
                <th>{t("lastOk")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} style={{ opacity: u.status === "banned" ? 0.55 : 1 }}>
                  <td>{u.name || "—"}</td>
                  <td className="num small">{u.telegramUsername ? `@${u.telegramUsername}` : u.telegramId ?? u.email ?? ""}</td>
                  <td className="num">{usd(u.balanceCents)}</td>
                  <td className="num">{u.orders}</td>
                  <td>{t(`r_${u.role}`)}</td>
                  <td>{ago(u.lastSeenAt, lang)}</td>
                  <td>
                    {owner && (
                      <button type="button" className="btn btn--xs btn--ghost press" onClick={() => setOpen(u)}>
                        {t("edit")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <UserSheet
          user={open}
          onClose={() => {
            setOpen(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function UserSheet({ user, onClose }: { user: U; onClose: () => void }) {
  const { t } = useT();
  const { me } = useApp();
  const action = useAction();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [key] = useState(idempotencyKey);
  const negative = amount.trim().startsWith("-");
  const abs = dollarsToCents(amount.replace("-", ""));
  const cents = abs === null ? null : negative ? -abs : abs;
  const self = me?.user.id === user.id;

  async function adjust() {
    if (cents === null || cents === 0 || note.trim().length < 3) return;
    if (await action.run(`/api/admin/users/${user.id}/wallet`, { body: { amountCents: cents, note: note.trim(), idempotencyKey: key } })) onClose();
  }
  async function role(r: U["role"], status?: U["status"]) {
    if (await action.run(`/api/admin/users/${user.id}/role`, { body: status ? { role: r, status } : { role: r } })) onClose();
  }

  return (
    <Sheet onClose={onClose} label={user.name || user.telegramUsername || user.id.slice(0, 8)}>
      <p className="small muted num">
        {usd(user.balanceCents)} · {user.telegramUsername ? `@${user.telegramUsername}` : user.email ?? ""}
      </p>
      <h3>{t("adjustWallet")}</h3>
      <p className="hint">{t("adjustHint")}</p>
      <div className="form-grid">
        <label className="field">
          <span>{t("amount")} (USD)</span>
          <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5.00 / -2.50" />
        </label>
        <label className="field">
          <span>{t("note")}</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("noteRequired")} />
        </label>
      </div>
      <button type="button" className="btn btn--block press" disabled={action.busy || cents === null || cents === 0 || note.trim().length < 3} onClick={adjust}>
        {action.busy ? <Spinner small /> : `${t("apply")} ${cents ? usd(cents) : ""}`}
      </button>
      {!self && (
        <>
          <h3>{t("role")}</h3>
          <div className="wrap">
            {(["customer", "support", "owner"] as const).map((r) => (
              <button key={r} type="button" className="chip chip--sm press" aria-pressed={user.role === r} disabled={action.busy} onClick={() => role(r)}>
                {t(`r_${r}`)}
              </button>
            ))}
          </div>
          <button type="button" className={user.status === "banned" ? "btn btn--sm btn--soft press" : "btn btn--sm btn--danger press"} disabled={action.busy} onClick={() => role(user.role, user.status === "banned" ? "active" : "banned")}>
            {user.status === "banned" ? t("unban") : t("ban")}
          </button>
        </>
      )}
    </Sheet>
  );
}
