/**
 * Admin → Settings plumbing: the settings loaded once and shared by every card,
 * saving (which also shows the change in this tab at once), and drafts.
 *
 * A draft is what the owner is typing in one card. It starts from that
 * setting's saved value and goes back to it only when *that* value changes on
 * the server, so saving one card never wipes what is being typed in another.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { applyTheme, getState, setState } from "../../lib/state";
import type { PublicConfig } from "../../lib/types";
import { useAction } from "../common";

export interface SettingsData {
  settings: Record<string, unknown>;
}

interface Ctx {
  settings: Record<string, unknown>;
  reload: () => Promise<void>;
}

const SettingsCtx = createContext<Ctx | null>(null);

export function SettingsProvider({ settings, reload, children }: Ctx & { children: ReactNode }) {
  return <SettingsCtx.Provider value={{ settings, reload }}>{children}</SettingsCtx.Provider>;
}

export function useSettings(): Ctx {
  const c = useContext(SettingsCtx);
  if (!c) throw new Error("useSettings outside SettingsProvider");
  return c;
}

/** Show a saved setting in this tab at once (other visitors get it within a minute). */
function applyLive(key: string, value: unknown): void {
  const cur = getState().config;
  if (!cur) return;
  if (key === "theme.preset") setState({ config: { ...cur, theme: { ...cur.theme, preset: value as PublicConfig["theme"]["preset"] } } });
  else if (key === "theme.default_mode") setState({ config: { ...cur, theme: { ...cur.theme, defaultMode: value as PublicConfig["theme"]["defaultMode"] } } });
  else if (key === "fx.syp_per_usd") setState({ config: { ...cur, sypPerUsd: value as number | null } });
  else if (key === "telegram.channel_url" && cur.telegram) setState({ config: { ...cur, telegram: { ...cur.telegram, channel: value as string | null } } });
  else if (key.startsWith("support.")) setState({ config: { ...cur, support: { ...cur.support, [key.slice(8)]: value as string | null } } });
  else if (key === "payments.stars_per_usd") setState({ config: { ...cur, payments: { ...cur.payments, starsPerUsd: value as number | null } } });
  else if (key === "payments.min_topup_cents") setState({ config: { ...cur, payments: { ...cur.payments, minCents: value as number } } });
  else if (key === "payments.max_topup_cents") setState({ config: { ...cur, payments: { ...cur.payments, maxCents: value as number } } });
  else if (key === "images.resize") setState({ config: { ...cur, images: { resize: value === true } } });
  else if (key === "push.enabled") setState({ config: { ...cur, push: { enabled: value === true } } });
  else return;
  applyTheme();
}

/** Save one or more settings in order (stopping at the first refusal), then read them all again. */
export function useSave(): { busy: boolean; save: (values: Record<string, unknown>) => Promise<boolean> } {
  const action = useAction();
  const { reload } = useSettings();
  async function save(values: Record<string, unknown>): Promise<boolean> {
    let ok = true;
    for (const [key, value] of Object.entries(values)) {
      if (!(await action.run(`/api/admin/settings/${key}`, { method: "PUT", body: { value } }))) {
        ok = false;
        break;
      }
      applyLive(key, value);
    }
    await reload();
    return ok;
  }
  return { busy: action.busy, save };
}

/**
 * A draft of any shape that follows `server` only when `server` itself changes
 * (compared by value, so a reload with the same value keeps the draft).
 */
export function useDraft<D>(server: unknown, toDraft: (v: unknown) => D): [D, (next: D | ((d: D) => D)) => void] {
  const sig = JSON.stringify(server ?? null);
  const [held, setHeld] = useState<{ sig: string; draft: D }>(() => ({ sig, draft: toDraft(server) }));
  let cur = held;
  if (held.sig !== sig) {
    cur = { sig, draft: toDraft(server) };
    setHeld(cur);
  }
  const set = (next: D | ((d: D) => D)) =>
    setHeld((h) => ({ sig: h.sig, draft: typeof next === "function" ? (next as (d: D) => D)(h.draft) : next }));
  return [cur.draft, set];
}

export interface SettingDraft<T> {
  /** What the box shows. */
  text: string;
  set: (text: string) => void;
  /** The value to save, or undefined while the text is not valid. */
  value: T | undefined;
  /** The text differs from the saved value. */
  dirty: boolean;
}

/**
 * One setting's text box: `format` turns the saved value into text, `parse`
 * turns the text back into the value to save (undefined: not valid yet).
 */
export function useSettingDraft<T>(key: string, parse: (text: string) => T | undefined, format: (saved: unknown) => string): SettingDraft<T> {
  const { settings } = useSettings();
  const saved = settings[key];
  const [text, set] = useDraft(saved, format);
  return { text, set, value: parse(text), dirty: text !== format(saved) };
}

// ───────────── common formats and parsers

/** A saved number as text, or `fallback` when it is not set. */
export const numText =
  (fallback = "", scale = 1) =>
  (v: unknown): string =>
    typeof v === "number" ? String(v / scale) : fallback;

/** Saved text as text ("" when not set). */
export const strText = (v: unknown): string => (typeof v === "string" ? v : "");

/** A number within [min, max] (`int`: whole numbers only); "" gives `empty` (undefined: required). */
export function numberIn(min: number, max: number, opts: { int?: boolean; empty?: null } = {}) {
  return (text: string): number | null | undefined => {
    const s = text.trim();
    if (s === "") return "empty" in opts ? opts.empty : undefined;
    const n = Number(s);
    if (!Number.isFinite(n) || n < min || n > max || (opts.int && !Number.isInteger(n))) return undefined;
    return n;
  };
}
