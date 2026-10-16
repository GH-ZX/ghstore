/** Small shared components: logo, sheets, tiles, money, states. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { store } from "@store/config";
import { errorText } from "../lib/i18n";
import { usd, syp } from "../lib/format";
import { useApp, useT } from "../lib/state";
import type { ApiFail } from "../lib/api";
import { pushBack } from "../lib/telegram";
import { CloseIcon } from "./icons";
import { LOGO } from "./logo";

/** Logo D: G and dot in the accent, H in the ink. */
export function Logo({ height = 22 }: { height?: number }) {
  const width = Math.round((height * 240) / 120);
  return (
    <svg width={width} height={height} viewBox={LOGO.viewBox} role="img" aria-label={store.mark}>
      {LOGO.strokes.map((s) => (
        <path key={s.d} d={s.d} fill="none" stroke={s.color} strokeWidth={s.width} />
      ))}
      <path d={LOGO.fill.d} fill={LOGO.fill.color} />
    </svg>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={small ? "spinner spinner--sm" : "spinner"} role="status" aria-label="…" />;
}

export function PageLoading() {
  return (
    <div className="stack" aria-busy="true">
      <div className="skeleton" style={{ height: 48 }} />
      <div className="skeleton" style={{ height: 120 }} />
      <div className="grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ height: 210 }} />
        ))}
      </div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiFail | null; onRetry?: () => void }) {
  const { t, lang } = useT();
  if (!error) return null;
  return (
    <div className="empty" role="alert">
      <span>{errorText(lang, error.code)}</span>
      {onRetry && (
        <button type="button" className="btn btn--sm btn--soft press" onClick={onRetry}>
          {t("retry")}
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A price in USD, with the Syrian pound equivalent underneath when the owner set a rate. */
export function Money({ cents, showSyp = false, className }: { cents: number; showSyp?: boolean; className?: string }) {
  const { config, lang } = useApp();
  const s = showSyp ? syp(cents, config?.sypPerUsd, lang) : null;
  return (
    <span className={className}>
      <span className="num">{usd(cents)}</span>
      {s && <span className="small muted" style={{ display: "block" }}>≈ {s}</span>}
    </span>
  );
}

/** Logos (brand marks, site icons, SVGs) are shown whole on a soft tile instead of cropped like photos. */
const LOGO_URL = /simpleicons|favicons|\.svg(\?|$)/i;

export function Tile({ name, imageUrl, className }: { name: string; imageUrl?: string | null; className?: string }) {
  // A picture that fails to load falls back to the store's picture template.
  const [broken, setBroken] = useState<string | null>(null);
  const show = imageUrl && broken !== imageUrl;
  const logo = show && LOGO_URL.test(imageUrl);
  if (!show) {
    // The picture template: a cover in a colour of its own (the same for the same
    // name, everywhere), with the product's monogram.
    return (
      <span className={`tile tile--art ${className ?? ""}`} style={{ "--h": ART_HUES[hashName(name) % ART_HUES.length] } as CSSProperties} aria-hidden="true">
        <span className="tile__mono">{monogramOf(name)}</span>
      </span>
    );
  }
  return (
    <span className={`tile${logo ? " tile--logo" : ""} ${className ?? ""}`} aria-hidden="true">
      <img src={imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(imageUrl)} />
    </span>
  );
}

/** Hues for the picture template: violet, magenta, rose, coral, amber, emerald, teal, blue. */
const ART_HUES = [285, 320, 355, 25, 60, 155, 195, 250];

function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function monogramOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const latin = words.find((w) => /^[A-Za-z0-9]/.test(w)) ?? words[0] ?? "•";
  return latin.slice(0, latin.length <= 3 && latin === latin.toUpperCase() ? 3 : 2).toUpperCase();
}

/**
 * Bottom sheet (dialog on wide screens). Closes on the backdrop, Escape and
 * Telegram's back button; keeps focus inside while open.
 */
export function Sheet({ onClose, label, children, foot, head }: { onClose: () => void; label: string; children: ReactNode; foot?: ReactNode; head?: ReactNode }) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, without re-running the open/close effect on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = () => closeRef.current();
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const popBack = pushBack(close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      popBack();
      prev?.focus?.();
    };
  }, []);
  return (
    <>
      <button type="button" className="backdrop" aria-label={t("close")} onClick={() => closeRef.current()} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
        <div className="sheet__handle">
          <span />
        </div>
        <div className="sheet__head">
          {head ?? <h2>{label}</h2>}
          <button type="button" className="icon-btn press" aria-label={t("close")} onClick={() => closeRef.current()}>
            <CloseIcon />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {foot && <div className="sheet__foot">{foot}</div>}
      </div>
    </>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="press" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Toast() {
  const { toast } = useApp();
  if (!toast) return null;
  return (
    <div key={toast.id} className={toast.bad ? "toast toast--bad" : "toast"} role="status" aria-live="polite">
      {toast.text}
    </div>
  );
}
