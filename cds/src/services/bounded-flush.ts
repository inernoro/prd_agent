export type BoundedFlushResult = 'flushed' | 'failed' | 'timeout';

export async function waitForFlushWithTimeout(
  flush: () => Promise<void>,
  timeoutMs: number,
  onError?: (err: unknown) => void,
): Promise<BoundedFlushResult> {
  return await Promise.race([
    flush().then(() => 'flushed' as const).catch((err) => {
      onError?.(err);
      return 'failed' as const;
    }),
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    }),
  ]);
}
