import { describe, expect, it, vi } from 'vitest';
import { waitForBootstrapExit } from '../../scripts/bootstrap-exit-wait.js';

describe('完整应用演练退出期限', () => {
  it('应用已经退出后不保留十五秒计时器', async () => {
    vi.useFakeTimers();
    try {
      await expect(waitForBootstrapExit(Promise.resolve({ code: 0 }), 15_000)).resolves.toEqual({ code: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('未退出仍等待原十五秒，到期后也不留计时器', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = waitForBootstrapExit(new Promise<never>(() => {}), 15_000).then(value => { done = true; return value; });
      await vi.advanceTimersByTimeAsync(14_999); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await expect(waiting).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
