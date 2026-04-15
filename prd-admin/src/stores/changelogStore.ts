import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  getCurrentWeekChangelog,
  getChangelogReleases,
  type CurrentWeekView,
  type ReleasesView,
  type ChangelogEntry,
} from '@/services';

interface ChangelogState {
  // 数据
  currentWeek: CurrentWeekView | null;
  releases: ReleasesView | null;
  // 加载状态
  loadingCurrent: boolean;
  loadingReleases: boolean;
  // 错误
  error: string | null;
  // 用户上次查看时间戳（ISO 字符串，sessionStorage 持久化）
  // 用于计算「自上次查看以来的新条目数量」=> 红点
  lastSeenAt: string | null;

  // Actions
  loadCurrentWeek: (force?: boolean) => Promise<void>;
  loadReleases: (limit?: number, force?: boolean) => Promise<void>;
  /** 用户已查看 → 标记当前时间为 lastSeenAt（清掉红点） */
  markAsSeen: () => void;
}

/**
 * 计算「未读条目数」：本周更新中比 lastSeenAt 更新的条目数。
 * 用于顶栏铃铛红点显示。
 *
 * 简化处理：用 fragment.date 做比较（精度到天即可）。
 * 首次使用（lastSeenAt 为 null）时，把所有本周条目视为新内容。
 */
export function selectUnreadCount(state: ChangelogState): number {
  const cw = state.currentWeek;
  if (!cw || !cw.dataSourceAvailable) return 0;

  const totalEntries = cw.fragments.reduce((sum, f) => sum + f.entries.length, 0);
  if (totalEntries === 0) return 0;

  const seen = state.lastSeenAt ? new Date(state.lastSeenAt) : null;
  if (!seen) return totalEntries;

  let unread = 0;
  for (const fragment of cw.fragments) {
    // 把日期字符串当作当天 23:59:59，避免跨时区误判
    const fragmentDay = new Date(`${fragment.date}T23:59:59`);
    if (fragmentDay > seen) {
      unread += fragment.entries.length;
    }
  }
  return unread;
}

/**
 * 拉平本周更新为「最近 N 条」列表（铃铛弹层使用）。
 */
export function selectRecentEntries(
  state: ChangelogState,
  limit = 5
): Array<ChangelogEntry & { date: string; fileName: string }> {
  const cw = state.currentWeek;
  if (!cw) return [];
  const flat: Array<ChangelogEntry & { date: string; fileName: string }> = [];
  for (const fragment of cw.fragments) {
    for (const entry of fragment.entries) {
      flat.push({ ...entry, date: fragment.date, fileName: fragment.fileName });
      if (flat.length >= limit) return flat;
    }
  }
  return flat;
}

export const useChangelogStore = create<ChangelogState>()(
  persist(
    (set, get) => ({
      currentWeek: null,
      releases: null,
      loadingCurrent: false,
      loadingReleases: false,
      error: null,
      lastSeenAt: null,

      loadCurrentWeek: async (force?: boolean) => {
        const { loadingCurrent, currentWeek } = get();
        if (loadingCurrent) return;
        if (currentWeek && !force) return;
        set({ loadingCurrent: true, error: null });
        const res = await getCurrentWeekChangelog();
        if (res.success) {
          set({ currentWeek: res.data, loadingCurrent: false });
        } else {
          set({ loadingCurrent: false, error: res.error?.message || '加载本周更新失败' });
        }
      },

      loadReleases: async (limit = 20, force?: boolean) => {
        const { loadingReleases, releases } = get();
        if (loadingReleases) return;
        if (releases && !force) return;
        set({ loadingReleases: true, error: null });
        const res = await getChangelogReleases(limit);
        if (res.success) {
          set({ releases: res.data, loadingReleases: false });
        } else {
          set({ loadingReleases: false, error: res.error?.message || '加载历史发布失败' });
        }
      },

      markAsSeen: () => {
        set({ lastSeenAt: new Date().toISOString() });
      },
    }),
    {
      name: 'changelog-store',
      // 严格遵守 no-localstorage 规则
      storage: createJSONStorage(() => sessionStorage),
      // 只持久化 lastSeenAt；数据每次会话重新拉取
      partialize: (s) => ({ lastSeenAt: s.lastSeenAt }),
    }
  )
);
