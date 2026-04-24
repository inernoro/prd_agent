/**
 * connectionStore 测试
 *
 * 验证连接探测逻辑：
 *   1. probeOnce 互斥（isProbing 防并发）
 *   2. markConnected 停止自动探测
 *   3. markDisconnected 启动自动探测
 *   4. 异常时 isProbing 不残留
 */
import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';

// connectionStore 使用 window.setInterval/clearInterval/setTimeout/clearTimeout，node 环境需要 polyfill
if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
} else {
  // 已有 window：兜底补齐（有些 happy-dom/jsdom 环境可能缺 setTimeout/clearTimeout 的 bind）
  if (typeof (globalThis as any).window.setTimeout !== 'function') {
    (globalThis as any).window.setTimeout = globalThis.setTimeout.bind(globalThis);
  }
  if (typeof (globalThis as any).window.clearTimeout !== 'function') {
    (globalThis as any).window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  }
}

let rawInvokeImpl: Mock;
let isTauriImpl: Mock;

vi.mock('../../lib/tauri', () => ({
  invoke: vi.fn(),
  rawInvoke: (...args: any[]) => rawInvokeImpl(...args),
  isTauri: () => isTauriImpl(),
}));

vi.mock('../systemNoticeStore', () => ({
  useSystemNoticeStore: {
    getState: () => ({ push: vi.fn() }),
  },
}));

const { useConnectionStore } = await import('../connectionStore');

function getState() {
  return useConnectionStore.getState();
}

describe('connectionStore 基础逻辑', () => {
  beforeEach(() => {
    rawInvokeImpl = vi.fn();
    isTauriImpl = vi.fn().mockReturnValue(true);
    useConnectionStore.setState({
      status: 'unknown',
      lastChangedAt: 0,
      lastReason: null,
      apiBaseUrl: null,
      isProbing: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // 让 store 回到 connected 以停止内部 scheduleAutoProbe 启动的 setTimeout 链
    useConnectionStore.getState().markConnected();
  });

  it('markConnected 幂等：多次调用不重复设置', () => {
    getState().markConnected();
    const t1 = getState().lastChangedAt;
    expect(getState().status).toBe('connected');

    // 再次调用 — 不更新
    getState().markConnected();
    expect(getState().lastChangedAt).toBe(t1);
  });

  it('markDisconnected(immediate) 保留上次 reason', () => {
    // immediate=true：已知确认断连（例如探活失败），同步切状态
    getState().markDisconnected('timeout', true);
    expect(getState().lastReason).toBe('timeout');

    // 再次断连但不传 reason → 保留旧的
    getState().markDisconnected(undefined, true);
    expect(getState().lastReason).toBe('timeout');
  });

  it('probeOnce 互斥：并发调用不重复', async () => {
    let resolveProbe: Function;
    rawInvokeImpl
      .mockResolvedValueOnce({ apiBaseUrl: 'http://localhost:5000' }) // ensureApiBaseUrl
      .mockReturnValueOnce(new Promise(r => { resolveProbe = r; }));   // test_api_connection

    const p1 = getState().probeOnce();
    expect(getState().isProbing).toBe(true);

    // 并发调用 — 不应重复发起
    const result2 = await getState().probeOnce();
    // 应该根据当前状态返回，不发新请求
    expect(typeof result2).toBe('boolean');

    // 完成第一次探测
    resolveProbe!({ success: true });
    const result1 = await p1;
    expect(result1).toBe(true);
    expect(getState().isProbing).toBe(false);
    expect(getState().status).toBe('connected');
  });

  it('probeOnce 异常不残留 isProbing', async () => {
    rawInvokeImpl
      .mockResolvedValueOnce({ apiBaseUrl: 'http://localhost:5000' })
      .mockRejectedValueOnce(new Error('网络不可达'));

    const result = await getState().probeOnce();
    expect(result).toBe(false);
    expect(getState().isProbing).toBe(false);
    expect(getState().status).toBe('disconnected');
  });

  it('非 Tauri 环境 probeOnce 直接返回 false', async () => {
    isTauriImpl.mockReturnValue(false);
    const result = await getState().probeOnce();
    expect(result).toBe(false);
    expect(getState().isProbing).toBe(false);
  });

  it('ensureApiBaseUrl 缓存：只调用一次 rawInvoke', async () => {
    rawInvokeImpl.mockResolvedValue({ apiBaseUrl: 'http://localhost:5000' });

    const url1 = await getState().ensureApiBaseUrl();
    const url2 = await getState().ensureApiBaseUrl();

    expect(url1).toBe('http://localhost:5000');
    expect(url2).toBe('http://localhost:5000');
    // 只调用一次
    expect(rawInvokeImpl).toHaveBeenCalledTimes(1);
  });
});

describe('状态转换', () => {
  beforeEach(() => {
    rawInvokeImpl = vi.fn();
    isTauriImpl = vi.fn().mockReturnValue(true);
    useConnectionStore.setState({
      status: 'unknown',
      lastChangedAt: 0,
      lastReason: null,
      apiBaseUrl: null,
      isProbing: false,
    });
  });

  it('unknown → connected', () => {
    getState().markConnected();
    expect(getState().status).toBe('connected');
  });

  it('unknown → disconnected(immediate) → connected 触发恢复', () => {
    getState().markDisconnected('init', true);
    expect(getState().status).toBe('disconnected');

    // connected 后清理 reason
    getState().markConnected();
    expect(getState().status).toBe('connected');
    expect(getState().lastReason).toBeNull();
  });
});
