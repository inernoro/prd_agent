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

  it('loadFromServer 拉到的脏数据被写入 store 前已去重（覆盖前缀形态 + AgentLauncherPage 的 __xxx__ 形态）', async () => {
    vi.mocked(getUserPreferences).mockResolvedValueOnce({
      success: true,
      error: null,
      data: {
        agentSwitcherPreferences: {
          pinnedIds: ['utility:logs', 'logs', '__logs__', 'visual-agent'],
          recentVisits: [
            { ...baseVisit, id: 'utility:logs', timestamp: 4 },
            { ...baseVisit, id: 'logs', timestamp: 3 },
            { ...baseVisit, id: '__logs__', timestamp: 2 },
            { ...baseVisit, id: 'document-store', agentName: '知识库', path: '/document-store', timestamp: 0 },
          ],
          usageCounts: {
            'utility:logs': 5,
            logs: 3,
            __logs__: 2,
            'visual-agent': 7,
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof getUserPreferences>>);

    await useAgentSwitcherStore.getState().loadFromServer();

    const { recentVisits, pinnedIds, usageCounts } = useAgentSwitcherStore.getState();

    // 三个老 id 形态（utility:logs / logs / __logs__）全部规范化为 'logs'，去重后只剩一条
    const logsVisits = recentVisits.filter((v) => v.id === 'logs');
    expect(logsVisits).toHaveLength(1);
    expect(recentVisits.find((v) => v.id === 'document-store')).toBeDefined();
    expect(recentVisits).toHaveLength(2);

    // 置顶也按 canonical id 去重
    expect(pinnedIds).toEqual(['logs', 'visual-agent']);

    // usageCounts 累加而非覆盖（5 + 3 + 2 = 10）
    expect(usageCounts.logs).toBe(10);
    expect(usageCounts['visual-agent']).toBe(7);
  });
});

describe('agentSwitcherStore: 水合竞态', () => {
  beforeEach(() => {
    useAgentSwitcherStore.setState({
      recentVisits: [],
      pinnedIds: [],
      usageCounts: {},
      serverLoaded: false,
      serverLoading: false,
    });
    vi.clearAllMocks();
  });

  it('水合期间的点击不会被远端数据抹掉', async () => {
    // AppShell 一进页就异步 loadFromServer；用户手快先点了一个智能体。
    // 那一刻 serverLoaded 还是 false，scheduleSync 直接 return（防空态覆盖云端），
    // 紧接着远端数据整体替换 recentVisits/usageCounts——点击连同计数一起消失。
    type PrefsResponse = Awaited<ReturnType<typeof getUserPreferences>>;
    let resolveLoad: (value: PrefsResponse) => void = () => {};
    vi.mocked(getUserPreferences).mockReturnValue(
      new Promise<PrefsResponse>((resolve) => { resolveLoad = resolve; }),
    );

    const loading = useAgentSwitcherStore.getState().loadFromServer();

    // 水合还在飞的时候点开视觉创作
    useAgentSwitcherStore.getState().addRecentVisit({ ...baseVisit, id: 'visual-agent', path: '/visual-agent' });

    resolveLoad({
      success: true,
      data: {
        agentSwitcherPreferences: {
          pinnedIds: [],
          recentVisits: [{ id: 'literary-agent', agentKey: '', agentName: '文学创作', title: '文学创作', path: '/literary-agent', icon: 'Feather', timestamp: 1 }],
          usageCounts: { 'literary-agent': 5 },
        },
      },
    } as unknown as PrefsResponse);
    await loading;

    const { recentVisits, usageCounts } = useAgentSwitcherStore.getState();
    expect(usageCounts['visual-agent'], '水合期间那次点击的计数被抹掉了').toBe(1);
    expect(usageCounts['literary-agent'], '远端计数没保住').toBe(5);
    expect(recentVisits[0]?.id, '水合期间那次点击应排在最近使用第一位').toBe('visual-agent');
    expect(recentVisits.some((v) => v.id === 'literary-agent'), '远端记录被挤掉了').toBe(true);
  });

  it('水合完成后队列清空，不会重复重放', async () => {
    vi.mocked(getUserPreferences).mockResolvedValue({
      success: true,
      data: { agentSwitcherPreferences: { pinnedIds: [], recentVisits: [], usageCounts: { 'visual-agent': 3 } } },
    } as unknown as Awaited<ReturnType<typeof getUserPreferences>>);

    useAgentSwitcherStore.getState().addRecentVisit({ ...baseVisit, id: 'visual-agent', path: '/visual-agent' });
    await useAgentSwitcherStore.getState().loadFromServer();
    expect(useAgentSwitcherStore.getState().usageCounts['visual-agent']).toBe(4);

    // 第二次水合（换号 / 手动刷新）不该把同一次点击再加一遍
    useAgentSwitcherStore.setState({ serverLoaded: false, serverLoading: false });
    await useAgentSwitcherStore.getState().loadFromServer();
    expect(useAgentSwitcherStore.getState().usageCounts['visual-agent']).toBe(3);
  });
});
