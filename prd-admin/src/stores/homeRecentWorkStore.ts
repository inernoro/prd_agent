import { create } from 'zustand';
import { listRecentWork } from '@/services';
import type { RecentWorkItemDto } from '@/services';
import { registerLogoutReset } from '@/stores/authStore';

interface HomeRecentWorkState {
  loaded: boolean;
  loading: boolean;
  /**
   * 上一次拉取失败了。
   *
   * 以前失败直接吞成空列表，理由是"该区块有数据才显示，失败不打扰用户"——
   * 这在区块整块隐藏时成立。首页改版后空态会明说「还没有进行中的工作」，
   * 同一个吞法就变成了当着老用户面说他没活干。失败要如实标出来。
   */
  failed: boolean;
  items: RecentWorkItemDto[];
  /** 拉取「继续上次」列表；默认跳过已 loaded */
  load: (opts?: { force?: boolean }) => Promise<void>;
  /** 清空为初始态（登出时调用，防止同浏览器换号短暂看到上一位用户的脚印） */
  reset: () => void;
}

const INITIAL_STATE = { loaded: false, loading: false, failed: false, items: [] as RecentWorkItemDto[] };

export const useHomeRecentWorkStore = create<HomeRecentWorkState>((set, get) => ({
  ...INITIAL_STATE,

  async load(opts) {
    const force = Boolean(opts?.force);
    const state = get();
    if (!force && (state.loaded || state.loading)) return;
    set({ loading: true });
    try {
      // 24 条：默认收起只露一行，「浏览全部脚印」展开后可翻看更长的足迹
      const res = await listRecentWork({ limit: 24 });
      if (res.success && res.data) {
        set({ items: res.data.items, loading: false, loaded: true, failed: false });
      } else {
        // 失败不清空已有列表：手上那份旧的比凭空变空更不吓人，
        // 由页面标注「没能刷新」并给重试。
        set({ loading: false, loaded: true, failed: true });
      }
    } catch {
      set({ loading: false, loaded: true, failed: true });
    }
  },

  reset() {
    set({ ...INITIAL_STATE });
  },
}));

// 脚印是 user-scoped 数据：登出即清空，换号登录后从空态重新拉取（Codex P2）。
// 同一用户 SPA 内返回首页时保留旧列表边拉边换（stale-while-revalidate），属有意设计。
registerLogoutReset(() => {
  useHomeRecentWorkStore.getState().reset();
});
