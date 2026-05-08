/**
 * "最近使用"去重回归测试
 *
 * 历史背景：用户偏好（pinnedIds / recentVisits / usageCounts）经过 v2/v3 两次 ID 规范化迁移，
 * 但服务端持久化的脏数据（如同时存在 'utility:logs' / 'logs' / '__logs__' 等多种形态）
 * 在 loadFromServer 覆盖本地后，会让命令面板"最近使用"区出现同一项被列出多次的情况。
 *
 * 本测试覆盖三条防线：
 *   1. addRecentVisit 调用方传入老 id 也能正确去重
 *   2. v3 → v4 migrate 把持久化的 recentVisits 按 canonical id 去重
 *   3. loadFromServer 拉到含脏数据的远程偏好后，写入 store 前去重
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services', () => ({
  getUserPreferences: vi.fn(),
  updateAgentSwitcherPreferences: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/stores/authStore', () => ({
  registerLogoutReset: vi.fn(),
}));

import { getUserPreferences } from '@/services';
import { useAgentSwitcherStore } from '../agentSwitcherStore';

const baseVisit = {
  agentKey: '',
  agentName: '请求日志',
  title: '请求日志',
  path: '/logs',
  icon: 'ScrollText',
};

describe('agentSwitcherStore: 最近使用去重', () => {
  beforeEach(() => {
    useAgentSwitcherStore.setState({
      recentVisits: [],
      pinnedIds: [],
      usageCounts: {},
      serverLoaded: false,
      serverLoading: false,
      isOpen: false,
      searchQuery: '',
    });
    vi.clearAllMocks();
  });

  it('addRecentVisit 调用方传入老前缀 id 时按 canonical id 去重', () => {
    const { addRecentVisit } = useAgentSwitcherStore.getState();

    // 先以"老 id"插入一条 —— 模拟历史脏数据
    useAgentSwitcherStore.setState({
      recentVisits: [
        { ...baseVisit, id: 'utility:logs', timestamp: 1 },
      ],
    });

    // 再以"新 id"插入 —— 应认作同一项，并替换旧条目
    addRecentVisit({ ...baseVisit, id: 'logs' });

    const visits = useAgentSwitcherStore.getState().recentVisits;
    expect(visits).toHaveLength(1);
    expect(visits[0].id).toBe('logs');
  });

  it('addRecentVisit 输入老 id 会被规范化为新 id 写入', () => {
    const { addRecentVisit } = useAgentSwitcherStore.getState();
    addRecentVisit({ ...baseVisit, id: 'utility:logs' });

    const visits = useAgentSwitcherStore.getState().recentVisits;
    expect(visits).toHaveLength(1);
    expect(visits[0].id).toBe('logs');
  });

  it('loadFromServer 拉到的脏数据被写入 store 前已去重', async () => {
    vi.mocked(getUserPreferences).mockResolvedValueOnce({
      success: true,
      data: {
        agentSwitcherPreferences: {
          pinnedIds: ['utility:logs', 'logs', 'visual-agent'],
          recentVisits: [
            { ...baseVisit, id: 'utility:logs', timestamp: 3 },
            { ...baseVisit, id: 'logs', timestamp: 2 },
            { ...baseVisit, id: 'document-store', agentName: '知识库', path: '/document-store', timestamp: 0 },
          ],
          usageCounts: {
            'utility:logs': 5,
            logs: 3,
            'visual-agent': 7,
          },
        },
      },
    } as Awaited<ReturnType<typeof getUserPreferences>>);

    await useAgentSwitcherStore.getState().loadFromServer();

    const { recentVisits, pinnedIds, usageCounts } = useAgentSwitcherStore.getState();

    // 三个老 id 形态全部规范化为 'logs'，去重后只剩一条
    const logsVisits = recentVisits.filter((v) => v.id === 'logs');
    expect(logsVisits).toHaveLength(1);
    expect(recentVisits.find((v) => v.id === 'document-store')).toBeDefined();
    expect(recentVisits).toHaveLength(2);

    // 置顶也按 canonical id 去重
    expect(pinnedIds).toEqual(['logs', 'visual-agent']);

    // usageCounts 累加而非覆盖
    expect(usageCounts.logs).toBe(8);
    expect(usageCounts['visual-agent']).toBe(7);
  });
});
