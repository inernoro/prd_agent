import { create } from 'zustand';
import { listRecentWork } from '@/services';
import type { RecentWorkItemDto } from '@/services';
import { registerLogoutReset } from '@/stores/authStore';

interface HomeRecentWorkState {
  loaded: boolean;
  loading: boolean;
  items: RecentWorkItemDto[];
  /** 拉取「继续上次」列表；默认跳过已 loaded */
  load: (opts?: { force?: boolean }) => Promise<void>;
  /** 清空为初始态（登出时调用，防止同浏览器换号短暂看到上一位用户的脚印） */
  reset: () => void;
}

const INITIAL_STATE = { loaded: false, loading: false, items: [] as RecentWorkItemDto[] };

// 请求代际：reset()（登出）时 +1，飞行中的 load() 回来发现代际变了就丢弃响应。
// 否则用户 A 的慢请求可能在用户 B 登录后落地，把 A 的脚印写进 B 的首页（Codex P2）。
let generation = 0;

export const useHomeRecentWorkStore = create<HomeRecentWorkState>((set, get) => ({
  ...INITIAL_STATE,

  async load(opts) {
    const force = Boolean(opts?.force);
    const state = get();
    if (!force && (state.loaded || state.loading)) return;
    const gen = generation;
    set({ loading: true });
    try {
      // 24 条：默认收起只露一行，「浏览全部脚印」展开后可翻看更长的足迹
      const res = await listRecentWork({ limit: 24 });
      if (gen !== generation) return; // 请求期间发生过登出：这是上一个账号的响应，丢弃
      // 拉取失败按空列表处理：该区块「有数据才显示」，失败不打扰用户
      set({ items: res.success && res.data ? res.data.items : [], loading: false, loaded: true });
    } catch {
      if (gen !== generation) return;
      set({ items: [], loading: false, loaded: true });
    }
  },

  reset() {
    generation += 1;
    set({ ...INITIAL_STATE });
  },
}));

// 脚印是 user-scoped 数据：登出即清空，换号登录后从空态重新拉取（Codex P2）。
// 同一用户 SPA 内返回首页时保留旧列表边拉边换（stale-while-revalidate），属有意设计。
registerLogoutReset(() => {
  useHomeRecentWorkStore.getState().reset();
});
