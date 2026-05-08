import { create } from 'zustand';
import {
  getCurrentWeeklyPoster,
  markWeeklyPosterSeen,
  type WeeklyPoster,
} from '@/services';

/**
 * 周报海报弹窗状态。
 *
 * "已读"持久化走后端：每张海报有 SeenBy: List<string>（用户ID 列表），用户看过一次后
 * 后端 GET /current 不再返回该海报；管理员发布新海报（不同 id，SeenBy 为空）时所有用户
 * 又会再弹一次。这样跨浏览器、跨设备、跨重新登录都对齐——"看过的不再看，有更新就再弹"。
 *
 * 同会话内的优化：dismissedIds (sessionStorage) 防止网络抖动导致 mark-seen 重复弹窗，
 * 但权威状态来自后端。
 */

const SESSION_DISMISS_KEY = 'weekly-poster-dismissed';

function loadSessionDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SESSION_DISMISS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveSessionDismissed(ids: Set<string>) {
  try {
    sessionStorage.setItem(SESSION_DISMISS_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

interface WeeklyPosterState {
  /** 后端返回的当前可见海报（已过滤已读） */
  currentPoster: WeeklyPoster | null;
  loading: boolean;
  /** 同会话已关闭的 id（防止瞬时重弹） */
  dismissedIds: Set<string>;

  loadCurrent: () => Promise<void>;
  dismiss: (posterId: string) => void;
  shouldShowCurrent: () => boolean;
}

export const useWeeklyPosterStore = create<WeeklyPosterState>((set, get) => ({
  currentPoster: null,
  loading: false,
  dismissedIds: loadSessionDismissed(),

  loadCurrent: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await getCurrentWeeklyPoster();
      if (res.success) {
        set({ currentPoster: res.data ?? null });
      }
    } catch {
      /* silent fail - 海报失败不能挡主页加载 */
    } finally {
      set({ loading: false });
    }
  },

  dismiss: (posterId: string) => {
    // 1) 同会话内立刻隐藏
    const next = new Set(get().dismissedIds);
    next.add(posterId);
    saveSessionDismissed(next);
    set({ dismissedIds: next });
    // 2) 持久化到后端 SeenBy（fire-and-forget；失败也只是下次进还会弹一次，无副作用）
    void markWeeklyPosterSeen(posterId).catch(() => { /* ignore */ });
  },

  shouldShowCurrent: () => {
    const poster = get().currentPoster;
    if (!poster || !poster.id) return false;
    if (!poster.pages || poster.pages.length === 0) return false;
    return !get().dismissedIds.has(poster.id);
  },
}));
