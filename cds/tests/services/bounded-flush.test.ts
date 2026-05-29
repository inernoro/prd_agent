import { describe, expect, it } from 'vitest';
import { waitForFlushWithTimeout } from '../../src/services/bounded-flush.js';

describe('waitForFlushWithTimeout', () => {
  it('returns flushed when persistence finishes before the deadline', async () => {
    await expect(waitForFlushWithTimeout(async () => undefined, 50)).resolves.toBe('flushed');
  });

  it('returns failed and reports the error when persistence throws', async () => {
    const errors: unknown[] = [];
    const result = await waitForFlushWithTimeout(async () => {
      throw new Error('mongo unavailable');
    }, 50, (err) => errors.push(err));

    expect(result).toBe('failed');
    expect((errors[0] as Error).message).toBe('mongo unavailable');
  });

  it('returns timeout when persistence hangs so restart paths can continue', async () => {
    const startedAt = Date.now();
    const result = await waitForFlushWithTimeout(async () => {
      await new Promise<void>(() => { /* stuck write-behind queue */ });
    }, 20);

    expect(result).toBe('timeout');
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
