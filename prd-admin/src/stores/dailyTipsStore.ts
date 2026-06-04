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

/**
 * 本会话内「已学会」的 *-page-guide sourceId 乐观覆盖集。
 * markLearned 是乐观更新(先本地标 learned=true,再异步 POST mark-learned),而 load 会用 /visible
 * 整包替换 items。若一次并发/陈旧刷新(抽屉打开时 load(force) / 60s 轮询 / 标签可见)在服务端回显
 * learned 之前落地,就会把乐观标记冲掉,matchPageGuide 又把该教程当成「没走完」→ 重新脉冲/自动开讲。
 * 解决:把学会的 sourceId 记进本集合,每次 load 落库后再叠加一次 learned=true,刷新不会再清掉它。
 * 仅内存(刷新页面后服务端 LearnedTips 已是权威源,/visible 自带 learned=true)。
 */
const locallyLearnedSourceIds = new Set<string>();

/** 用本会话乐观学会集叠加 learned=true,保证刷新不丢标记 */
function applyLocalLearned(items: DailyTip[]): DailyTip[] {
  if (locallyLearnedSourceIds.size === 0) return items;
  return items.map((t) =>
    t.sourceId && locallyLearnedSourceIds.has(t.sourceId) && !t.learned
      ? { ...t, learned: true }
      : t,
  );
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
        // applyLocalLearned:叠加本会话乐观学会标记,避免陈旧刷新把 learned=true 冲掉(Bugbot)
        set({ items: applyLocalLearned(res.data.items ?? []), loaded: true });
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
    // *-page-guide:学会后仍保留(供用户重看),仅本地标 learned=true 停止自动开讲 / 入口脉冲。
    // 其余 tip:本地立即移除(避免视觉延迟)。调用失败不回滚 — 用户下次刷新最多再看一次。
    const tip = get().items.find((t) => t.id === id);
    const isPageGuide = typeof tip?.sourceId === 'string' && tip.sourceId.endsWith('-page-guide');
    if (isPageGuide) {
      // 记进本会话乐观学会集,后续任何 load 整包替换 items 时都会再叠加 learned=true(Bugbot)
      if (tip?.sourceId) locallyLearnedSourceIds.add(tip.sourceId);
      set({ items: get().items.map((t) => (t.id === id ? { ...t, learned: true } : t)) });
    } else {
      set({ items: get().items.filter((t) => t.id !== id) });
    }
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
