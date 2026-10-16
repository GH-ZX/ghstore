/**
 * Load JSON from the API for a screen, with a small shared cache so switching
 * tabs shows the last data at once and refreshes it in the background.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFail } from "./api";

const cache = new Map<string, unknown>();
/** Loads started before their screen asked (start-up), shared with the screen. */
const inflight = new Map<string, Promise<unknown>>();

/** Start loading a screen's data early; the screen then uses this load instead of starting its own. */
export function prefetch<T>(path: string): Promise<T> {
  let p = inflight.get(path) as Promise<T> | undefined;
  if (!p) {
    p = api<T>(path)
      .then((d) => {
        cache.set(path, d);
        return d;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, p);
  }
  return p;
}

export function invalidate(prefix: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

export interface Loaded<T> {
  data: T | undefined;
  error: ApiFail | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useApi<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T | undefined) : undefined));
  const [error, setError] = useState<ApiFail | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null && !cache.has(path));
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(!cache.has(path));
    setError(null);
    try {
      const d = await ((inflight.get(path) as Promise<T> | undefined) ?? api<T>(path));
      cache.set(path, d);
      if (current.current === path) setData(d);
    } catch (e) {
      if (current.current === path) setError(e instanceof ApiFail ? e : new ApiFail("internal", 0));
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setData(path ? (cache.get(path) as T | undefined) : undefined);
    void load();
  }, [path, load]);

  return { data, error, loading, reload: load };
}
