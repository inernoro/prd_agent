import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPwaServiceWorker } from './pwa';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('PWA 在托管网页预览沙箱中', () => {
  it('浏览器同步禁止读取 serviceWorker 时保留安全限制并结束注册', () => {
    let onLoad: (() => void) | undefined;
    const denied = new DOMException('Sandboxed origin', 'SecurityError');
    vi.stubGlobal('navigator', { get serviceWorker() { throw denied; } });
    vi.stubGlobal('window', {
      isSecureContext: true,
      addEventListener: vi.fn((_event: string, handler: () => void) => { onLoad = handler; }),
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerPwaServiceWorker();
    expect(onLoad).toBeTypeOf('function');
    expect(() => onLoad!()).not.toThrow();
    expect(warning).toHaveBeenCalledWith('[pwa] service worker 注册失败:', denied);
  });
});
