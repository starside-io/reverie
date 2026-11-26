import { useCallback, useEffect, useRef, useState } from "react";

import { RpcError, rpc } from "@/client";

/**
 * Reads and writes over /rpc, with the smallest amount of machinery that does
 * the job: a cache keyed by tool and input, and a version counter that every
 * write bumps so the open screens refetch.
 *
 * No query library. Five screens and one endpoint do not need one, and the
 * thing worth being explicit about here is which writes invalidate which
 * reads, not which cache library is in fashion.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let version = 0;

/** Tells every open read to run again. Called after a write. */
export function invalidate(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export interface ReadState<T> {
  data: T | undefined;
  error: RpcError | undefined;
  loading: boolean;
  /** True while a refetch runs over data that is already on screen. */
  refreshing: boolean;
  reload: () => void;
}

export function useRpc<T>(
  tool: string | null,
  input: unknown = {},
  options: { enabled?: boolean } = {},
): ReadState<T> {
  const enabled = options.enabled !== false && tool !== null;
  const key = `${tool ?? ""}:${JSON.stringify(input ?? {})}`;

  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<RpcError | undefined>(undefined);
  const [pending, setPending] = useState(enabled);
  const [seen, setSeen] = useState(version);
  const keyRef = useRef(key);

  if (keyRef.current !== key) {
    keyRef.current = key;
    // A different question: the old answer is not this question's answer.
    setData(undefined);
    setError(undefined);
  }

  useEffect(() => {
    const listener = () => setSeen(version);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!enabled || tool === null) {
      setPending(false);
      return;
    }

    let live = true;
    setPending(true);

    rpc<T>(tool, input)
      .then((result) => {
        if (!live) return;
        setData(result);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setError(
          caught instanceof RpcError
            ? caught
            : new RpcError(tool, "failed", String(caught)),
        );
      })
      .finally(() => {
        if (live) setPending(false);
      });

    return () => {
      live = false;
    };
    // The key stands in for the input, which is compared by value not identity.
  }, [tool, key, enabled, seen]);

  const reload = useCallback(() => setSeen((current) => current + 1), []);

  return {
    data,
    error,
    loading: pending && data === undefined,
    refreshing: pending && data !== undefined,
    reload,
  };
}

export interface WriteState<T> {
  run: (input?: unknown) => Promise<T | undefined>;
  pending: boolean;
  error: RpcError | undefined;
  /** The last result, for a screen that wants to show what landed. */
  result: T | undefined;
  reset: () => void;
}

/**
 * One write. Every successful call invalidates the open reads, because a tool
 * can touch more than the screen that called it: logging an occasion moves
 * closeness, which the dashboard is showing.
 */
export function useWrite<T>(tool: string): WriteState<T> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<RpcError | undefined>(undefined);
  const [result, setResult] = useState<T | undefined>(undefined);

  const run = useCallback(
    async (input: unknown = {}) => {
      setPending(true);
      setError(undefined);
      try {
        const value = await rpc<T>(tool, input);
        setResult(value);
        invalidate();
        return value;
      } catch (caught) {
        setError(
          caught instanceof RpcError ? caught : new RpcError(tool, "failed", String(caught)),
        );
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [tool],
  );

  const reset = useCallback(() => {
    setError(undefined);
    setResult(undefined);
  }, []);

  return { run, pending, error, result, reset };
}
