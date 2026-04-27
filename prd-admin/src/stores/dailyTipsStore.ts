import { create } from 'zustand';
import type { DailyTip } from '@/services/real/dailyTips';
import { listVisibleTips, markTipAsLearned } from '@/services/real/dailyTips';

const DISMISSED_KEY = 'dailyTipDismissedIds';

function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function writeDismissed(ids: Set<string>) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* sessionStorage may be unavailable (privacy mode) */
  }
}

interface DailyTipsState {
  items: DailyTip[];
  loaded: boolean;
  loading: boolean;
  dismissed: Set<string>;
  /** 首次加载。已加载时默认不重复;force=true 时强制重拉(用于轮询 / 可见性变化)。 */
  load: (opts?: { force?: boolean }) => Promise<void>;
  dismiss: (id: string) => void;
  /** 标记某条 tip 为「已学会」:服务端写 (SourceId, Version) + 本地立即移除。 */
  markLearned: (id: string) => Promise<void>;
  /** 「text」类 tip(副标题轮播使用) */
  textTips: () => DailyTip[];
  /** 「card」/「spotlight」类 tip(右下抽屉使用),已自动过滤 session 关闭项 */
  cardTips: () => DailyTip[];
}

export const useDailyTipsStore = create<DailyTipsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  dismissed: readDismissed(),

  async load(opts) {
    const { loading, loaded } = get();
    if (loading) return;
    if (loaded && !opts?.force) return;
    set({ loading: true });
    try {
      const res = await listVisibleTips();
      if (res.success && res.data) {
        set({ items: res.data.items ?? [], loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  dismiss(id: string) {
    const next = new Set(get().dismissed);
    next.add(id);
    writeDismissed(next);
    set({ dismissed: next });
  },

  async markLearned(id: string) {
    // 先本地立即移除(避免视觉延迟),再调服务端;调用失败也不回滚 — 用户下次刷新最多再看一次
    set({ items: get().items.filter((t) => t.id !== id) });
    try {
      await markTipAsLearned(id);
    } catch {
      /* 失败静默,不阻塞 UI */
    }
  },

  textTips() {
    return get().items.filter((t) => t.kind === 'text');
  },

  cardTips() {
    const { dismissed } = get();
    return get()
      .items.filter((t) => t.kind === 'card' || t.kind === 'spotlight')
      .filter((t) => !dismissed.has(t.id));
  },
}));

// ── 自动轮询:60s 刷新一次;标签页从隐藏变可见时立即刷新 ──
// 让管理员后台「推送」操作在 1 分钟内送达用户,不需要用户手动 F5。
if (typeof window !== 'undefined') {
  const REFRESH_INTERVAL_MS = 60_000;

  window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void useDailyTipsStore.getState().load({ force: true });
  }, REFRESH_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void useDailyTipsStore.getState().load({ force: true });
    }
  });
}
