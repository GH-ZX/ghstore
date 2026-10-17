/**
 * Load JSON from the API for a screen, with a small shared cache so switching
 * tabs shows the last data at once. Data younger than FRESH_MS is shown without
 * asking again; older data shows at once and refreshes in the background.
 * reload() always asks the server. Loads of the same path at the same time
 * share one request.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFail } from "./api";

/** How long loaded data counts as fresh: opening its screen again within this does not refetch. */
const FRESH_MS = 30_000;

interface Entry {
  data: unknown;
  at: number;
}

const cache = new Map<string, Entry>();
/** Loads under way, shared by everyone asking for the same path (start-up prefetches too). */
const inflight = new Map<string, Promise<unknown>>();
/** Bumped by clearCache(): answers to requests made before it are not kept. */
let generation = 0;
/** Mounted useApi hooks, told when the whole cache is cleared (sign-out, another account). */
const clearListeners = new Set<() => void>();

function load<T>(path: string): Promise<T> {
  const running = inflight.get(path) as Promise<T> | undefined;
  if (running) return running;
  const gen = generation;
  const p: Promise<T> = api<T>(path)
    .then((d) => {
      // Not kept when the cache was cleared or this path invalidated while it ran.
      if (gen === generation && inflight.get(path) === p) cache.set(path, { data: d, at: Date.now() });
      return d;
    })
    .finally(() => {
      if (inflight.get(path) === p) inflight.delete(path);
    });
  inflight.set(path, p);
  return p;
}

/** Start loading a screen's data early; the screen then uses this load instead of starting its own. */
export function prefetch<T>(path: string): Promise<T> {
  return load<T>(path);
}

/** Forget cached data (and loads under way) for every path starting with `prefix`. */
export function invalidate(prefix: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
}

/** Forget everything (signing out, or another account signed in): nothing of one person's shows to the next. */
export function clearCache(): void {
  generation++;
  cache.clear();
  inflight.clear();
  for (const l of [...clearListeners]) l();
}

export interface Loaded<T> {
  data: T | undefined;
  error: ApiFail | null;
  loading: boolean;
  reload: () => Promise<void>;
}

interface HookState {
  path: string | null;
  data: unknown;
  error: ApiFail | null;
  loading: boolean;
}

function initial(path: string | null): HookState {
  if (!path) return { path, data: undefined, error: null, loading: false };
  const hit = cache.get(path);
  return { path, data: hit?.data, error: null, loading: !hit };
}

export function useApi<T>(path: string | null): Loaded<T> {
  const [held, setHeld] = useState<HookState>(() => initial(path));
  // A new path: start from what the cache has for it, never the previous path's data.
  let s = held;
  if (s.path !== path) {
    s = initial(path);
    setHeld(s);
  }
  const current = useRef(path);
  current.current = path;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchNow = useCallback(
    async (force: boolean) => {
      if (!path) return;
      const hit = cache.get(path);
      if (!force && hit && Date.now() - hit.at < FRESH_MS) return;
      setHeld((x) => (x.path === path ? { ...x, loading: x.data === undefined, error: null } : x));
      try {
        const d = await load<T>(path);
        if (alive.current && current.current === path) setHeld((x) => (x.path === path ? { path, data: d, error: null, loading: false } : x));
      } catch (e) {
        const f = e instanceof ApiFail ? e : new ApiFail("internal", 0);
        if (alive.current && current.current === path) setHeld((x) => (x.path === path ? { ...x, error: f, loading: false } : x));
      }
    },
    [path],
  );

  useEffect(() => {
    void fetchNow(false);
  }, [fetchNow]);

  // The cache was cleared: drop what this screen shows and ask again.
  useEffect(() => {
    const onClear = () => {
      if (!alive.current) return;
      setHeld(initial(current.current));
      void fetchNow(true);
    };
    clearListeners.add(onClear);
    return () => {
      clearListeners.delete(onClear);
    };
  }, [fetchNow]);

  const reload = useCallback(() => fetchNow(true), [fetchNow]);
  return { data: s.data as T | undefined, error: s.error, loading: s.loading, reload };
}
