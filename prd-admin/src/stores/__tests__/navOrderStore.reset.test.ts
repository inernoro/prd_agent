import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserPreferences, updateNavLayout } = vi.hoisted(() => ({
  getUserPreferences: vi.fn(),
  updateNavLayout: vi.fn(async () => ({ success: true, data: undefined, error: null })),
}));
vi.mock('@/services', () => ({ getUserPreferences, updateNavLayout }));

import { useNavOrderStore } from '@/stores/navOrderStore';

/**
 * 守卫：管理员按人重置 / 恢复所有用户之后，用户下一次加载不能再用 sessionStorage 里的旧布局把重置撤销。
 * 判据是服务端的 navLayoutSynced：空数组 + true = 主动清空；空数组 + false = 从没同步过（才允许回填）。
 */
describe('navOrderStore.loadFromServer 与重置的关系', () => {
  beforeEach(() => {
    useNavOrderStore.getState().reset();
    useNavOrderStore.setState({ navOrder: ['ai-toolbox', 'users'], navHidden: ['logs'], loaded: false });
    getUserPreferences.mockReset();
    updateNavLayout.mockClear();
  });

  it('服务端主动清空过（navLayoutSynced=true）：丢掉本地缓存，不回传', async () => {
    getUserPreferences.mockResolvedValue({
      success: true,
      data: { navOrder: [], navHidden: [], navLayoutSynced: true, defaultNavOrder: ['ai-toolbox'], defaultNavHidden: [] },
    });
    await useNavOrderStore.getState().loadFromServer();
    const s = useNavOrderStore.getState();
    expect(s.navOrder).toEqual([]);
    expect(s.navHidden).toEqual([]);
    expect(s.defaultNavOrder).toEqual(['ai-toolbox']);
    expect(updateNavLayout).not.toHaveBeenCalled();
  });

  it('服务端从没同步过（navLayoutSynced=false）：沿用旧行为，本地缓存回填并上传', async () => {
    getUserPreferences.mockResolvedValue({
      success: true,
      data: { navOrder: [], navHidden: [], navLayoutSynced: false, defaultNavOrder: [], defaultNavHidden: [] },
    });
    await useNavOrderStore.getState().loadFromServer();
    expect(useNavOrderStore.getState().navOrder).toEqual(['ai-toolbox', 'users']);
    expect(updateNavLayout).toHaveBeenCalledWith({ navOrder: ['ai-toolbox', 'users'], navHidden: ['logs'] });
  });
});
