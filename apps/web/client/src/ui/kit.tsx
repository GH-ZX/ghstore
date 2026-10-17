/** Small shared components: logo, sheets, tiles, money, states. */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const { t } = useT();
  return <span className={small ? "spinner spinner--sm" : "spinner"} role="status" aria-label={t("loading")} />;
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

/** Open sheets, oldest first: only the top one is live; the page and the sheets under it are inert. */
const openSheets: HTMLElement[] = [];

function syncInert(): void {
  const root = document.getElementById("root");
  const top = openSheets[openSheets.length - 1];
  if (root) root.inert = openSheets.length > 0;
  for (const el of openSheets) el.inert = el !== top;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet (dialog on wide screens), drawn over the page (a portal on
 * <body>). Closes on the backdrop, Escape and Telegram's back button. While it
 * is open the page behind (and any sheet under it) is inert, Tab cycles inside
 * it, and only the top sheet answers Escape.
 */
export function Sheet({ onClose, label, children, foot, head, waiting = false }: { onClose: () => void; label: string; children: ReactNode; foot?: ReactNode; head?: ReactNode; waiting?: boolean }) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // The latest onClose, without re-running the open/close effect on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const el = layer.current!;
    const close = () => closeRef.current();
    const prev = document.activeElement as HTMLElement | null;
    openSheets.push(el);
    syncInert();
    ref.current?.focus();
    const isTop = () => openSheets[openSheets.length - 1] === el;
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        ref.current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === ref.current || !ref.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const popBack = pushBack(close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      popBack();
      const i = openSheets.lastIndexOf(el);
      if (i >= 0) openSheets.splice(i, 1);
      el.inert = false;
      syncInert();
      prev?.focus?.();
    };
  }, []);
  // A sheet that waited (hidden) takes the focus when it shows.
  const waited = useRef(waiting);
  useEffect(() => {
    if (waited.current && !waiting) ref.current?.focus();
    waited.current = waiting;
  }, [waiting]);
  return createPortal(
    <div ref={layer}>
      <button type="button" className="backdrop" aria-label={t("close")} tabIndex={-1} onClick={() => closeRef.current()} />
      {/* Waiting: the sheet slides up once its content is there, at its real height, instead of growing (and moving) as it fills. */}
      {waiting && (
        <div className="sheet-wait">
          <Spinner />
        </div>
      )}
      <div className={waiting ? "sheet sheet--waiting" : "sheet"} role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
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
    </div>,
    document.body,
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

/**
 * The toast. One live region stays mounted (on <body>, so a sheet making the
 * page inert does not silence it) and only its text changes, which is what
 * screen readers announce reliably.
 */
export function Toast() {
  const { toast } = useApp();
  return createPortal(
    <div role="status" aria-live="polite" aria-atomic="true">
      {toast && (
        <div key={toast.id} className={toast.bad ? "toast toast--bad" : "toast"}>
          {toast.text}
        </div>
      )}
    </div>,
    document.body,
  );
}
