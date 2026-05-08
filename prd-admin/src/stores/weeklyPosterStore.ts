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
  /**
   * 用户**主动**点 ✕ 关闭过的 id（仅当前 SPA 视图生效）。
   * 不包含 1.5s 自动 markSeen 的 id —— 静默持久化不应让 modal 消失。
   */
  closedIds: Set<string>;

  loadCurrent: () => Promise<void>;
  /** 用户主动关闭：写后端 SeenBy + 立即隐藏 UI */
  dismiss: (posterId: string) => void;
  /** 静默标记已读：仅写后端 SeenBy + sessionStorage，不隐藏 UI（让用户继续看完） */
  markSeen: (posterId: string) => void;
  shouldShowCurrent: () => boolean;
}

export const useWeeklyPosterStore = create<WeeklyPosterState>((set, get) => ({
  currentPoster: null,
  loading: false,
  closedIds: loadSessionDismissed(),

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

  markSeen: (posterId: string) => {
    // 仅持久化（后端 SeenBy + sessionStorage 当作"已经登记"标记），不动 closedIds → modal 保持显示
    const cur = get().closedIds;
    if (!cur.has(posterId)) {
      const next = new Set(cur);
      next.add(posterId);
      saveSessionDismissed(next);
      // 注意：写 sessionStorage 但**不** set({closedIds:next})，避免触发 shouldShowCurrent 变 false
    }
    void markWeeklyPosterSeen(posterId).catch(() => { /* ignore */ });
  },

  dismiss: (posterId: string) => {
    // 用户主动关闭：先持久化，再隐藏 UI
    void markWeeklyPosterSeen(posterId).catch(() => { /* ignore */ });
    const next = new Set(get().closedIds);
    next.add(posterId);
    saveSessionDismissed(next);
    set({ closedIds: next });
  },

  shouldShowCurrent: () => {
    const poster = get().currentPoster;
    if (!poster || !poster.id) return false;
    if (!poster.pages || poster.pages.length === 0) return false;
    return !get().closedIds.has(poster.id);
  },
}));
