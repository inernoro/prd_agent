import { describe, expect, it, vi } from 'vitest';
import { installAuthzAutoRefresh } from '../authzAutoRefresh';

function createEventTarget() {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
  };
}

async function flushPromiseChain() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('installAuthzAutoRefresh', () => {
  it('在页面重新可见、窗口聚焦和定时触发时刷新当前权限', async () => {
    const windowTarget = createEventTarget();
    const documentTarget = Object.assign(createEventTarget(), { visibilityState: 'hidden' });
    let intervalHandler: (() => void) | undefined;
    const timerApi = {
      setInterval: vi.fn((handler: () => void) => {
        intervalHandler = handler;
        return 7 as unknown as ReturnType<typeof setInterval>;
      }),
      clearInterval: vi.fn(),
    };
    const refresh = vi.fn(async () => undefined);

    const dispose = installAuthzAutoRefresh({
      refresh,
      windowTarget,
      documentTarget,
      timerApi,
      intervalMs: 1234,
    });

    windowTarget.listeners.get('focus')?.();
    expect(refresh).not.toHaveBeenCalled();

    documentTarget.visibilityState = 'visible';
    documentTarget.listeners.get('visibilitychange')?.();
    await flushPromiseChain();
    expect(refresh).toHaveBeenCalledTimes(1);

    windowTarget.listeners.get('focus')?.();
    await flushPromiseChain();
    expect(refresh).toHaveBeenCalledTimes(2);

    intervalHandler?.();
    await flushPromiseChain();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(timerApi.setInterval).toHaveBeenCalledWith(expect.any(Function), 1234);

    dispose();
    expect(timerApi.clearInterval).toHaveBeenCalled();
    expect(windowTarget.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(documentTarget.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('上一轮刷新未完成时不并发重复请求', async () => {
    const windowTarget = createEventTarget();
    const documentTarget = Object.assign(createEventTarget(), { visibilityState: 'visible' });
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    const timerApi = {
      setInterval: vi.fn(() => 9 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    };

    const dispose = installAuthzAutoRefresh({ refresh, windowTarget, documentTarget, timerApi });
    windowTarget.listeners.get('focus')?.();
    documentTarget.listeners.get('visibilitychange')?.();
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await flushPromiseChain();
    windowTarget.listeners.get('focus')?.();
    expect(refresh).toHaveBeenCalledTimes(2);
    dispose();
  });
});
