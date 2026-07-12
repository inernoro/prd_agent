import { describe, expect, it } from 'vitest';
import { resolveHistoryViewAction, type HistoryViewSnapshot } from '../useHistoryBackedView';

/**
 * 全屏视图 <-> 浏览器历史 双向同步的决策表测试。
 * 场景语言：value = 页面状态（详情开/关），urlValue = URL query 里的视图标识。
 */
const base: HistoryViewSnapshot = {
  mounted: true,
  pushed: false,
  canGoBack: false,
  prevValue: null,
  value: null,
  prevUrl: null,
  urlValue: null,
};

describe('resolveHistoryViewAction 决策表', () => {
  it('状态侧打开视图（列表点进详情）：push 进历史', () => {
    expect(resolveHistoryViewAction({ ...base, prevValue: null, value: 'a', urlValue: null }))
      .toEqual({ kind: 'push' });
  });

  it('状态侧在两个视图间切换（执行列表进执行详情）：push 新条目', () => {
    expect(resolveHistoryViewAction({ ...base, prevValue: 'list', value: 'detail.1', prevUrl: 'list', urlValue: 'list' }))
      .toEqual({ kind: 'push' });
  });

  it('内部返回按钮关闭且本会话 push 过：真弹栈（与手势返回同源）', () => {
    expect(resolveHistoryViewAction({ ...base, pushed: true, canGoBack: true, prevValue: 'a', value: null, prevUrl: 'a', urlValue: 'a' }))
      .toEqual({ kind: 'pop' });
  });

  it('内部关闭但 param 是深链直达带进来的（没 push 过）：replace 清理，不误退出站外', () => {
    expect(resolveHistoryViewAction({ ...base, pushed: false, canGoBack: false, prevValue: 'a', value: null, prevUrl: 'a', urlValue: 'a' }))
      .toEqual({ kind: 'clean' });
  });

  it('手势/浏览器返回弹掉 param：关闭视图回列表', () => {
    expect(resolveHistoryViewAction({ ...base, pushed: true, prevValue: 'a', value: 'a', prevUrl: 'a', urlValue: null }))
      .toEqual({ kind: 'exit' });
  });

  it('前进/返回落在另一个视图条目上：恢复到 URL 指定视图', () => {
    expect(resolveHistoryViewAction({ ...base, prevValue: 'detail.1', value: 'detail.1', prevUrl: 'detail.1', urlValue: 'list' }))
      .toEqual({ kind: 'restore' });
  });

  it('挂载时 URL 带 param（深链/刷新）：恢复视图', () => {
    expect(resolveHistoryViewAction({ ...base, mounted: false, urlValue: 'a' }))
      .toEqual({ kind: 'restore' });
  });

  it('挂载时 URL 与状态已一致（store 持久化恢复）：无动作', () => {
    expect(resolveHistoryViewAction({ ...base, mounted: false, value: 'a', urlValue: 'a' }))
      .toEqual({ kind: 'none' });
  });

  it('挂载时视图开着但 URL 没 param（sessionStorage 自动恢复详情）：补 push 保证可返回', () => {
    expect(resolveHistoryViewAction({ ...base, mounted: false, value: 'a', urlValue: null }))
      .toEqual({ kind: 'push' });
  });

  it('push 后 effect 因 URL 更新重跑（value 与 urlValue 已一致）：无动作，不死循环', () => {
    expect(resolveHistoryViewAction({ ...base, pushed: true, prevValue: 'a', value: 'a', prevUrl: null, urlValue: 'a' }))
      .toEqual({ kind: 'none' });
  });

  it('pop 关闭后 popstate 让 param 消失（value 已是 null）：无动作', () => {
    expect(resolveHistoryViewAction({ ...base, prevValue: null, value: null, prevUrl: 'a', urlValue: null }))
      .toEqual({ kind: 'none' });
  });
});
