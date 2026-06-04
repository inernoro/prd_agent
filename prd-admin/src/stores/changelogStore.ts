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
 * 计算「未读条目数」：待发布碎片中比 lastSeenAt 更新的条目数。
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
 * 拉平待发布更新为「最近 N 条」列表（铃铛弹层使用）。
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

// 冷加载在途时被守卫挡掉的重读请求（如 SSE update 在初次冷加载期间到达）记一个 pending，
// 待在途请求结束后补跑一次 force=false 的后台重读，避免页面停在「冷加载启动时拿到的旧快照」
// （Codex P2：store-backed tab 也要 queue SSE reload，与 GitHub 日志的 trailing-edge 对称）。
let pendingCurrentWeekReload = false;
let pendingReleasesReload = false;

export const useChangelogStore = create<ChangelogState>()(
  persist(
    (set, get) => ({
      currentWeek: null,
      releases: null,
      loadingCurrent: false,
      loadingReleases: false,
      error: null,
      lastSeenAt: null,

      // stale-while-revalidate：有 sessionStorage 缓存时立即渲染旧数据并后台静默刷新
      //（不翻 loadingCurrent，避免每次打开都闪 loading）；无缓存时才显示 loading。
      loadCurrentWeek: async (force?: boolean) => {
        const { loadingCurrent, currentWeek } = get();
        if (loadingCurrent) {
          // 冷加载在途：不丢弃，记 pending，待结束补跑（拿到 SSE push 后的最新存量）
          pendingCurrentWeekReload = true;
          return;
        }
        const hasCache = currentWeek != null;
        if (!hasCache) set({ loadingCurrent: true, error: null });
        // force 透传到后端：force=true 会绕过后端 IMemoryCache，从 local/GitHub 重新拉取
        const res = await getCurrentWeekChangelog(force === true);
        if (res.success) {
          set({ currentWeek: res.data, loadingCurrent: false });
        } else if (!hasCache) {
          set({ loadingCurrent: false, error: res.error?.message || '加载待发布更新失败' });
        } else {
          set({ loadingCurrent: false }); // 后台刷新失败：保留旧数据，不打扰
        }
        // trailing-edge：在途期间被合并掉的重读补跑一次（force=false 读存量，此时已是最新快照）
        if (pendingCurrentWeekReload) {
          pendingCurrentWeekReload = false;
          void get().loadCurrentWeek(false);
        }
      },

      loadReleases: async (limit = 20, force?: boolean) => {
        const { loadingReleases, releases } = get();
        if (loadingReleases) {
          pendingReleasesReload = true;
          return;
        }
        const hasCache = releases != null;
        if (!hasCache) set({ loadingReleases: true, error: null });
        const res = await getChangelogReleases(limit, force === true);
        if (res.success) {
          set({ releases: res.data, loadingReleases: false });
        } else if (!hasCache) {
          set({ loadingReleases: false, error: res.error?.message || '加载历史发布失败' });
        } else {
          set({ loadingReleases: false }); // 后台刷新失败：保留旧数据
        }
        if (pendingReleasesReload) {
          pendingReleasesReload = false;
          void get().loadReleases(limit, false);
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
      // v1 起一并持久化 releases / currentWeek：进页面先渲染缓存，后台静默刷新，
      // 消除「每次打开都转圈」。sessionStorage 随标签页关闭清空，跨会话仍会冷拉一次。
      version: 1,
      // 旧版本（v0，只存 lastSeenAt）升级时：保留 lastSeenAt，数据字段重置为 null（首次进入冷拉一次）。
      migrate: (persisted) => ({
        lastSeenAt: (persisted as { lastSeenAt?: string | null } | null)?.lastSeenAt ?? null,
        releases: null,
        currentWeek: null,
      }),
      partialize: (s) => ({
        lastSeenAt: s.lastSeenAt,
        releases: s.releases,
        currentWeek: s.currentWeek,
      }),
    }
  )
);
