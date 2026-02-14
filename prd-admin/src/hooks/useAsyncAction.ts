import { useState, useCallback, useRef } from 'react';

/**
 * Wraps an async function with automatic loading state management.
 *
 * - Sets `loading = true` **before** the async call starts (immediate click feedback).
 * - Prevents duplicate execution while a call is in-flight.
 * - Resets `loading = false` in `finally` (both success & error).
 *
 * Usage:
 * ```tsx
 * const [save, saving] = useAsyncAction(async () => { await api.save(data); });
 * <Button onClick={save} disabled={saving}>
 *   {saving ? <Loader2 className="animate-spin" /> : '保存'}
 * </Button>
 * ```
 */
export function useAsyncAction<Args extends unknown[]>(
  fn: (...args: Args) => Promise<unknown>,
): [(...args: Args) => Promise<void>, boolean] {
  const [loading, setLoading] = useState(false);
  const inflightRef = useRef(false);

  const execute = useCallback(
    async (...args: Args) => {
      if (inflightRef.current) return;
      inflightRef.current = true;
      setLoading(true);
      try {
        await fn(...args);
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [fn],
  );

  return [execute, loading];
}
