import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  getCurrentWeekChangelog,
  getChangelogReleases,
  getChangelogReleaseByVersion,
  type CurrentWeekView,
  type ReleasesView,
  type ChangelogEntry,
  type ChangelogFragment,
} from '@/services';

interface ChangelogState {
  // 数据
  currentWeek: CurrentWeekView | null;
  releases: ReleasesView | null;
  // 加载状态
  loadingCurrent: boolean;
  loadingReleases: boolean;
  /** 正在按需拉取详情的版本（避免并发重复） */
  loadingReleaseVersions: Record<string, true>;
  /** 正在加载更多碎片日期组（避免并发重复触发） */
  loadingMoreFragments: boolean;
  // 错误
  error: string | null;
  // 用户上次查看时间戳（ISO 字符串，sessionStorage 持久化）
  // 用于计算「自上次查看以来的新条目数量」=> 红点
  lastSeenAt: string | null;

  // Actions
  /**
   * 首屏只拉 daysLimit 个日期组（默认 4），全量计数走 totalEntries/totalDays。
   * 续接走 loadMoreFragments。
   */
  loadCurrentWeek: (opts?: { daysLimit?: number; force?: boolean }) => Promise<void>;
  /** 续接更多碎片日期组，append 到现有 fragments 末尾 */
  loadMoreFragments: () => Promise<void>;
  /**
   * 首屏 summary=true（只元数据 + 计数，体积 <5kB），详情按需补
   */
  loadReleases: (opts?: { limit?: number; summary?: boolean; force?: boolean }) => Promise<void>;
  /** 按版本懒加载 entries 并 patch 进 releases 数组 */
  loadReleaseDetail: (version: string) => Promise<void>;
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
// 待在途请求结束后补跑一次，避免页面停在「冷加载启动时拿到的旧快照」
// （Codex P2：store-backed tab 也要 queue SSE reload，与 GitHub 日志的 trailing-edge 对称）。
// force 取「或」：在途期间若有任一次 force=true（如用户点了头部刷新），补跑须保留 force，
// 不能把硬刷新静默降级为只读重读（Bugbot Medium）。
let pendingCurrentWeekReload = false;
let pendingCurrentWeekForce = false;
let pendingReleasesReload = false;
let pendingReleasesForce = false;

// 单调递增请求号：暖缓存路径允许并发 force=false 拉取（SSE 重读 + mount 刷新等），
// 响应可能乱序到达。只让「最新一次请求」的响应落地，丢弃迟到的旧响应，
// 防止旧 in-flight 覆盖服务器刚 push 的新数据（Bugbot：SSE reloads race store updates；
// 对应项目既有约定 fetchId stale-response guard）。
let currentWeekFetchSeq = 0;
let releasesFetchSeq = 0;

export const useChangelogStore = create<ChangelogState>()(
  persist(
    (set, get) => ({
      currentWeek: null,
      releases: null,
      loadingCurrent: false,
      loadingReleases: false,
      loadingReleaseVersions: {},
      loadingMoreFragments: false,
      error: null,
      lastSeenAt: null,

      // stale-while-revalidate：有 sessionStorage 缓存时立即渲染旧数据并后台静默刷新
      //（不翻 loadingCurrent，避免每次打开都闪 loading）；无缓存时才显示 loading。
      loadCurrentWeek: async (opts) => {
        const { daysLimit, force } = opts || {};
        const { loadingCurrent, currentWeek } = get();
        if (loadingCurrent) {
          pendingCurrentWeekReload = true;
          pendingCurrentWeekForce = pendingCurrentWeekForce || force === true;
          return;
        }
        const hasCache = currentWeek != null;
        if (!hasCache) set({ loadingCurrent: true, error: null });
        const mySeq = ++currentWeekFetchSeq;
        const res = await getCurrentWeekChangelog({ daysLimit, force: force === true });
        if (mySeq !== currentWeekFetchSeq) return;
        if (res.success) {
          set({ currentWeek: res.data, loadingCurrent: false });
        } else if (!hasCache) {
          set({ loadingCurrent: false, error: res.error?.message || '加载待发布更新失败' });
        } else {
          set({ loadingCurrent: false });
        }
        if (pendingCurrentWeekReload) {
          pendingCurrentWeekReload = false;
          const f = pendingCurrentWeekForce;
          pendingCurrentWeekForce = false;
          void get().loadCurrentWeek({ daysLimit, force: f });
        }
      },

      loadMoreFragments: async () => {
        const { currentWeek, loadingMoreFragments } = get();
        if (loadingMoreFragments) return;
        if (!currentWeek) return;
        if (!currentWeek.hasMore) return;
        const nextOffset = currentWeek.fragments.length + (currentWeek.daysOffset ?? 0);
        set({ loadingMoreFragments: true });
        try {
          const res = await getCurrentWeekChangelog({
            daysLimit: 6,
            daysOffset: nextOffset,
          });
          if (!res.success || !res.data) return;
          // 增量追加：保留 totals/counts 以最新响应为准
          const merged: CurrentWeekView = {
            ...res.data,
            fragments: [
              ...(get().currentWeek?.fragments ?? []),
              ...res.data.fragments,
            ] as ChangelogFragment[],
          };
          set({ currentWeek: merged });
        } finally {
          set({ loadingMoreFragments: false });
        }
      },

      loadReleases: async (opts) => {
        const { limit = 8, summary = false, force } = opts || {};
        const { loadingReleases, releases } = get();
        if (loadingReleases) {
          pendingReleasesReload = true;
          pendingReleasesForce = pendingReleasesForce || force === true;
          return;
        }
        const hasCache = releases != null;
        if (!hasCache) set({ loadingReleases: true, error: null });
        const mySeq = ++releasesFetchSeq;
        const res = await getChangelogReleases({ limit, summary, force: force === true });
        if (mySeq !== releasesFetchSeq) return;
        if (res.success) {
          set({ releases: res.data, loadingReleases: false });
        } else if (!hasCache) {
          set({ loadingReleases: false, error: res.error?.message || '加载历史发布失败' });
        } else {
          set({ loadingReleases: false });
        }
        if (pendingReleasesReload) {
          pendingReleasesReload = false;
          const f = pendingReleasesForce;
          pendingReleasesForce = false;
          void get().loadReleases({ limit, summary, force: f });
        }
      },

      loadReleaseDetail: async (version: string) => {
        const { releases, loadingReleaseVersions } = get();
        if (!releases) return;
        if (loadingReleaseVersions[version]) return;
        const target = releases.releases.find((r) => r.version === version);
        if (!target || !target.entriesOmitted) return; // 已有详情

        set({ loadingReleaseVersions: { ...loadingReleaseVersions, [version]: true } });
        try {
          const res = await getChangelogReleaseByVersion(version);
          if (!res.success || !res.data) return;
          const detail = res.data;
          // patch 进现有 releases 数组（保持引用变化触发 react 重渲染）
          set((state) => {
            if (!state.releases) return state;
            return {
              releases: {
                ...state.releases,
                releases: state.releases.releases.map((r) =>
                  r.version === version
                    ? { ...r, days: detail.days, entriesOmitted: false }
                    : r,
                ),
              },
            };
          });
        } finally {
          set((state) => {
            const next = { ...state.loadingReleaseVersions };
            delete next[version];
            return { loadingReleaseVersions: next };
          });
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
