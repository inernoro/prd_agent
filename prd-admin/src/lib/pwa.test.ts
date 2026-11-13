import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPwaServiceWorker } from './pwa';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('PWA 注册的浏览器上下文边界', () => {
  function context(serviceWorker: PropertyDescriptor, secure = true) {
    const listeners: Array<() => void> = [];
    vi.stubGlobal('window', { isSecureContext: secure, addEventListener: (_: string, cb: () => void) => listeners.push(cb) });
    vi.stubGlobal('navigator', Object.defineProperty({}, 'serviceWorker', serviceWorker));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerPwaServiceWorker();
    return { load: () => listeners.forEach(cb => cb()), listeners, warn };
  }

  it('正常安全上下文在加载后注册收件箱', async () => {
    const register = vi.fn().mockResolvedValue({});
    const c = context({ value: { register } });
    expect(register).not.toHaveBeenCalled();
    c.load();
    await Promise.resolve();
    expect(register).toHaveBeenCalledWith('/sw.js');
    expect(c.warn).not.toHaveBeenCalled();
  });

  it('沙箱拒绝读取容器时不产生未捕获异常', () => {
    const c = context({ get: () => { throw new DOMException('Opaque sandbox', 'SecurityError'); } });
    expect(c.load).not.toThrow();
    expect(c.warn).toHaveBeenCalledOnce();
  });

  it('异步注册拒绝仍留有诊断记录', async () => {
    const c = context({ value: { register: vi.fn().mockRejectedValue(new Error('Denied')) } });
    c.load();
    await Promise.resolve();
    expect(c.warn).toHaveBeenCalledOnce();
  });

  it('不安全上下文不访问受限容器', () => {
    const get = vi.fn(() => { throw new Error('不应读取'); });
    const c = context({ get }, false);
    c.load();
    expect(c.listeners).toHaveLength(0);
    expect(get).not.toHaveBeenCalled();
  });
});
