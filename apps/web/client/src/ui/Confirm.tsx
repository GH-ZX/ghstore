/**
 * "Are you sure?" without window.confirm: Telegram's own dialog inside the Mini
 * App, else a small sheet of ours (<ConfirmHost /> sits next to <Toast />).
 */
import { useSyncExternalStore } from "react";
import { useT } from "../lib/state";
import { tg } from "../lib/telegram";
import { Sheet } from "./kit";

interface Ask {
  text: string;
  yes?: string;
  danger?: boolean;
  done: (ok: boolean) => void;
}

let current: Ask | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Ask the person to confirm; resolves true for yes. */
export function askConfirm(text: string, opts: { yes?: string; danger?: boolean } = {}): Promise<boolean> {
  const w = tg();
  if (w?.showConfirm && w.isVersionAtLeast("6.2")) {
    return new Promise((resolve) => {
      try {
        w.showConfirm!(text, (ok) => resolve(ok));
      } catch {
        resolve(false);
      }
    });
  }
  return new Promise((resolve) => {
    current?.done(false);
    current = {
      text,
      ...opts,
      done: (ok) => {
        current = null;
        emit();
        resolve(ok);
      },
    };
    emit();
  });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function ConfirmHost() {
  const { t } = useT();
  const ask = useSyncExternalStore(subscribe, () => current, () => current);
  if (!ask) return null;
  return (
    <Sheet
      onClose={() => ask.done(false)}
      label={t("confirmTitle")}
      foot={
        <div className="wrap" style={{ gap: 8 }}>
          <button type="button" className={ask.danger ? "btn btn--danger press" : "btn press"} style={{ flex: 1 }} onClick={() => ask.done(true)}>
            {ask.yes ?? t("ok")}
          </button>
          <button type="button" className="btn btn--ghost press" style={{ flex: 1 }} onClick={() => ask.done(false)}>
            {t("cancel")}
          </button>
        </div>
      }
    >
      <p style={{ margin: 0 }}>{ask.text}</p>
    </Sheet>
  );
}
