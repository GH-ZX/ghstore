/**
 * When pictures start loading. The browser's own loading="lazy" starts far
 * ahead (over a thousand pixels, and along every sideways shelf), so on a phone
 * dozens of pictures would compete with the first screen's. Here a picture loads
 * when it comes within a short distance of the screen (also inside a shelf that
 * scrolls sideways), and anything not on the first screen waits for the page's
 * load event.
 */
import { useEffect, useState, type RefObject } from "react";

type Watcher = (near: boolean) => void;
const watchers = new Map<Element, Watcher>();
let observer: IntersectionObserver | null = null;

function shared(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver !== "function") return observer;
  // scrollMargin (newer browsers) extends the distance inside sideways shelves too.
  const init: IntersectionObserverInit & { scrollMargin?: string } = { rootMargin: "300px 200px", scrollMargin: "200px" };
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) watchers.get(e.target)?.(true);
  }, init);
  return observer;
}

/** True once the element is on the screen or close to it (always true without IntersectionObserver). */
export function useNear(ref: RefObject<Element | null>, skip = false, key?: unknown): boolean {
  const [near, setNear] = useState(skip);
  useEffect(() => {
    const el = ref.current;
    const io = shared();
    if (near || !el) return;
    if (!io) return setNear(true);
    watchers.set(el, (v) => {
      if (!v) return;
      setNear(true);
      io.unobserve(el);
      watchers.delete(el);
    });
    io.observe(el);
    return () => {
      io.unobserve(el);
      watchers.delete(el);
    };
  }, [ref, near, key]);
  return near;
}

let loaded = typeof document !== "undefined" && document.readyState === "complete";
const onLoad = new Set<() => void>();
if (!loaded && typeof window !== "undefined") {
  window.addEventListener(
    "load",
    () => {
      loaded = true;
      for (const fn of onLoad) fn();
      onLoad.clear();
    },
    { once: true },
  );
}

/** True once the page has loaded (its first screen's pictures included). */
export function usePageLoaded(): boolean {
  const [ok, setOk] = useState(loaded);
  useEffect(() => {
    if (ok) return;
    if (loaded) return setOk(true);
    const fn = () => setOk(true);
    onLoad.add(fn);
    return () => {
      onLoad.delete(fn);
    };
  }, [ok]);
  return ok;
}
