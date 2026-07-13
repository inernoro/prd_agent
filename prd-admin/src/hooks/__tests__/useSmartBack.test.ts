import { afterEach, describe, expect, it, vi } from 'vitest';
import { canGoBackInApp } from '../useSmartBack';

/**
 * canGoBackInApp 判定依据：react-router v7 会把 { idx } 写进 window.history.state，
 * idx > 0 表示本标签页存在由路由管理的站内上一条历史。
 * 测试环境为 node，无真实 window，这里 stub 最小结构。
 */
function stubHistoryState(state: unknown) {
  vi.stubGlobal('window', { history: { state } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canGoBackInApp 站内可返回判定', () => {
  it('idx > 0：存在站内上一条，可安全 navigate(-1)', () => {
    stubHistoryState({ idx: 1, key: 'abc', usr: null });
    expect(canGoBackInApp()).toBe(true);
    stubHistoryState({ idx: 5 });
    expect(canGoBackInApp()).toBe(true);
  });

  it('idx === 0：本标签页首条（深链直达/刷新后 replace 链），必须走兜底', () => {
    stubHistoryState({ idx: 0, key: 'default' });
    expect(canGoBackInApp()).toBe(false);
  });

  it('state 为 null（非路由创建的条目，如整页刷新进入的外站条目）：走兜底', () => {
    stubHistoryState(null);
    expect(canGoBackInApp()).toBe(false);
  });

  it('state 无 idx 字段或类型不对：走兜底而非误弹到外站', () => {
    stubHistoryState({ foo: 'bar' });
    expect(canGoBackInApp()).toBe(false);
    stubHistoryState({ idx: 'not-a-number' });
    expect(canGoBackInApp()).toBe(false);
  });
});
