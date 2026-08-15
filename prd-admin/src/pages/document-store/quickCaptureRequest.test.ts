import { describe, expect, it, vi } from 'vitest';
import { getSharedQuickCaptureRequest, type QuickCaptureRequestHolder } from './quickCaptureRequest';

describe('getSharedQuickCaptureRequest', () => {
  it('StrictMode 重跑 effect 时复用请求并让第二个订阅者消费结果', async () => {
    let resolveRequest!: (value: string) => void;
    const request = new Promise<string>((resolve) => { resolveRequest = resolve; });
    const createRequest = vi.fn(() => request);
    const holder: QuickCaptureRequestHolder<string> = { current: null };

    let firstEffectAlive = true;
    const firstSubscription = getSharedQuickCaptureRequest(holder, createRequest).then((value) => (
      firstEffectAlive ? value : null
    ));
    firstEffectAlive = false;

    let secondEffectResult: string | null = null;
    const secondSubscription = getSharedQuickCaptureRequest(holder, createRequest).then((value) => {
      secondEffectResult = value;
    });

    resolveRequest('快捷知识库');
    await Promise.all([firstSubscription, secondSubscription]);

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(secondEffectResult).toBe('快捷知识库');
    expect(holder.current).toBeNull();
  });
});
