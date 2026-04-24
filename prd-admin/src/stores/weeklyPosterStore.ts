import { create } from 'zustand';
import {
  getCurrentWeeklyPoster,
  type WeeklyPoster,
} from '@/services';

/**
 * 周报海报弹窗状态。
 *
 * 用户维度的「已读」状态用 sessionStorage 本地记录即可(关闭浏览器后重开再弹一次也不会打扰,
 * 登录后的主页展示期望是「同一会话只看一次」)。无需开用户表,遵循奥卡姆剃刀。
 * 若未来需要跨会话精确统计,再在后端加 mark-seen 端点。
 */

const DISMISSED_STORAGE_KEY = 'weekly-poster-dismissed';

function loadDismissedIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveDismissedIds(ids: Set<string>) {
  try {
    sessionStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

interface WeeklyPosterState {
  /** 后端最新可见的 published 海报 */
  currentPoster: WeeklyPoster | null;
  loading: boolean;
  /** 当前会话已关闭的海报 id 集合 */
  dismissedIds: Set<string>;

  /** 拉取当前海报(首屏挂载时调一次即可) */
  loadCurrent: () => Promise<void>;
  /** 关闭当前海报(本次会话不再弹出) */
  dismiss: (posterId: string) => void;
  /** 是否应该弹出当前海报 */
  shouldShowCurrent: () => boolean;
}

export const useWeeklyPosterStore = create<WeeklyPosterState>((set, get) => ({
  currentPoster: null,
  loading: false,
  dismissedIds: loadDismissedIds(),

  loadCurrent: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await getCurrentWeeklyPoster();
      if (res.success) {
        set({ currentPoster: res.data ?? null });
      }
    } catch {
      /* silent fail - 海报能失败不影响主页加载 */
    } finally {
      set({ loading: false });
    }
  },

  dismiss: (posterId: string) => {
    const next = new Set(get().dismissedIds);
    next.add(posterId);
    saveDismissedIds(next);
    set({ dismissedIds: next });
  },

  shouldShowCurrent: () => {
    const poster = get().currentPoster;
    if (!poster || !poster.id) return false;
    if (!poster.pages || poster.pages.length === 0) return false;
    return !get().dismissedIds.has(poster.id);
  },
}));
