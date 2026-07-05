import { create } from 'zustand';
import { listRecentWork } from '@/services';
import type { RecentWorkItemDto } from '@/services';

interface HomeRecentWorkState {
  loaded: boolean;
  loading: boolean;
  items: RecentWorkItemDto[];
  /** 拉取「继续上次」列表；默认跳过已 loaded */
  load: (opts?: { force?: boolean }) => Promise<void>;
}

export const useHomeRecentWorkStore = create<HomeRecentWorkState>((set, get) => ({
  loaded: false,
  loading: false,
  items: [],

  async load(opts) {
    const force = Boolean(opts?.force);
    const state = get();
    if (!force && (state.loaded || state.loading)) return;
    set({ loading: true });
    try {
      // 24 条：默认收起只露一行，「浏览全部脚印」展开后可翻看更长的足迹
      const res = await listRecentWork({ limit: 24 });
      // 拉取失败按空列表处理：该区块「有数据才显示」，失败不打扰用户
      set({ items: res.success && res.data ? res.data.items : [], loading: false, loaded: true });
    } catch {
      set({ items: [], loading: false, loaded: true });
    }
  },
}));
