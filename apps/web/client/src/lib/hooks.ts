/** Small hooks shared by the screens: polling, countdowns, copying. */
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./format";
import type { MsgKey } from "./i18n";
import { toast, useT } from "./state";
import { haptic } from "./telegram";

/**
 * Call `fn` every `ms` while `ms` is a number (null stops it). Each call waits
 * for the previous one to finish, nothing runs while the page is hidden (it
 * resumes when the page shows again), and nothing runs after unmount.
 */
export function usePoll(fn: () => unknown, ms: number | null): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (ms === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (stopped || document.hidden) return;
      try {
        await latest.current();
      } catch {
        /* the next round tries again */
      }
      schedule();
    };
    // Back on the page: carry on (a hidden page schedules nothing).
    const onVisible = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms]);
}

/** Whole seconds left until `iso`, ticking every second; null without a time. */
export function useSecondsLeft(iso: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    setNow(Date.now()); // count from now, not from when the screen opened
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
}

/** 75 → "1:15". */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Copy a text with a little buzz in Telegram and a "Copied" toast (or another message). */
export function useCopy(): (text: string, done?: MsgKey) => Promise<boolean> {
  const { t } = useT();
  return useCallback(
    async (text: string, done: MsgKey = "copied") => {
      const ok = await copyText(text);
      if (ok) {
        haptic("success");
        toast(t(done));
      }
      return ok;
    },
    [t],
  );
}
