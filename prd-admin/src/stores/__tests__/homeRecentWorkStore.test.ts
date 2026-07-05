import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services', () => ({
  listRecentWork: vi.fn(),
}));

// 捕获 store 模块加载时注册的 logout 重置回调，供测试直接触发
// vi.mock 会被提升到 import 之前，回调数组必须走 vi.hoisted 同步提升
const logoutResetCallbacks = vi.hoisted(() => [] as Array<() => void>);
vi.mock('@/stores/authStore', () => ({
  registerLogoutReset: (fn: () => void) => {
    logoutResetCallbacks.push(fn);
    return () => {};
  },
}));

import { listRecentWork } from '@/services';
import { useHomeRecentWorkStore } from '@/stores/homeRecentWorkStore';
import type { ApiResponse } from '@/types/api';
import type { RecentWorkItemDto } from '@/services/contracts/homeRecentWork';

const mockList = vi.mocked(listRecentWork);

function ok(items: RecentWorkItemDto[]): ApiResponse<{ items: RecentWorkItemDto[] }> {
  return { success: true, data: { items }, error: null };
}

describe('homeRecentWorkStore', () => {
  beforeEach(() => {
    useHomeRecentWorkStore.setState({ loaded: false, loading: false, items: [] });
    mockList.mockReset();
  });

  it('load 成功时写入 items 并置 loaded', async () => {
    mockList.mockResolvedValue(
      ok([{ route: '/visual-agent/abc123', agentKey: 'visual-agent', title: '未来科技城市海报', lastActiveAt: '2026-07-05T00:00:00Z' }])
    );
    await useHomeRecentWorkStore.getState().load();
    const s = useHomeRecentWorkStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].route).toBe('/visual-agent/abc123');
  });

  it('load 失败时按空列表处理（首页该区块「有数据才显示」，失败不打扰用户）', async () => {
    mockList.mockResolvedValue({ success: false, data: null, error: { code: 'INTERNAL', message: 'boom' } });
    await useHomeRecentWorkStore.getState().load();
    const s = useHomeRecentWorkStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.items).toEqual([]);
  });

  it('已 loaded 时默认不重复请求，force 才重拉', async () => {
    mockList.mockResolvedValue(ok([]));
    await useHomeRecentWorkStore.getState().load();
    await useHomeRecentWorkStore.getState().load();
    expect(mockList).toHaveBeenCalledTimes(1);
    await useHomeRecentWorkStore.getState().load({ force: true });
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('登出重置回调已注册，触发后清空脚印（同浏览器换号不残留上一位用户的标题）', async () => {
    mockList.mockResolvedValue(
      ok([{ route: '/defect-agent?defectId=d1', agentKey: 'defect-agent', title: '登录页崩溃', lastActiveAt: '2026-07-05T00:00:00Z' }])
    );
    await useHomeRecentWorkStore.getState().load();
    expect(useHomeRecentWorkStore.getState().items).toHaveLength(1);

    expect(logoutResetCallbacks.length).toBeGreaterThan(0);
    for (const fn of logoutResetCallbacks) fn();

    const s = useHomeRecentWorkStore.getState();
    expect(s.items).toEqual([]);
    expect(s.loaded).toBe(false);
    expect(s.loading).toBe(false);
  });
});
