export type LiteraryImageAttempt = 'completed' | 'failed' | 'pending';

/** 每次只提交一张；连续两次失败或结果未确认时暂停，未发送项保持原状。 */
export async function runLiteraryImageBatch<T>(
  items: readonly T[],
  execute: (item: T) => Promise<LiteraryImageAttempt>,
  signal: AbortSignal,
) {
  let completed = 0, failed = 0, attempted = 0, consecutiveFailures = 0;
  let paused = false;
  for (const item of items) {
    if (signal.aborted) break;
    const result = await execute(item);
    attempted++;
    if (result === 'pending') { paused = true; break; }
    if (result === 'completed') { completed++; consecutiveFailures = 0; }
    else { failed++; consecutiveFailures++; }
    if (consecutiveFailures >= 2) { paused = true; break; }
  }
  return { completed, failed, attempted, remaining: items.length - attempted, paused };
}
