import { create } from 'zustand';
import type { DailyTip } from '@/services/real/dailyTips';
import { listVisibleTips, markTipAsLearned } from '@/services/real/dailyTips';
import { registerLogoutReset } from '@/stores/authStore';

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
 * 本会话内「已学会」的 *-page-guide:sourceId → 学会时的内容版本号。
 * markLearned 是乐观更新(先本地标 learned=true,再异步 POST mark-learned),而 load 会用 /visible
 * 整包替换 items。若一次并发/陈旧刷新(抽屉打开时 load(force) / 60s 轮询 / 标签可见)在服务端回显
 * learned 之前落地,就会把乐观标记冲掉,matchPageGuide 又把该教程当成「没走完」→ 重新脉冲/自动开讲。
 * 解决:记下学会时的版本号,每次 load 落库后用 applyLocalLearned 叠加 learned=true。
 *
 * 关键:按版本号 gate(镜像后端 FilterLearned 的 `learnedVer >= t.Version` 语义)——只有「学会时的
 * 版本 >= 服务端当前版本」才覆盖。这样:
 *  - 陈旧刷新(同版本、服务端还没回显 learned)→ 覆盖,标记不丢;
 *  - 管理员 bump 版本(服务端 learned=false 且 version 更高)→ 不覆盖,教程正常重新出现,
 *    不会被本会话乐观标记一直压制到整页刷新(Bugbot)。
 * 仅内存(刷新页面后服务端 LearnedTips 已是权威源,/visible 自带 learned)。
 */
const locallyLearnedVersions = new Map<string, number>();

/** 用本会话乐观学会版本叠加 learned=true,保证陈旧刷新不丢标记;版本被 bump 时不压制(见上注释) */
function applyLocalLearned(items: DailyTip[]): DailyTip[] {
  if (locallyLearnedVersions.size === 0) return items;
  return items.map((t) => {
    if (t.learned || !t.sourceId) return t;
    const learnedVer = locallyLearnedVersions.get(t.sourceId);
    return learnedVer != null && learnedVer >= (t.version ?? 1)
      ? { ...t, learned: true }
      : t;
  });
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
      // 记进本会话乐观学会版本(sourceId → 学会时版本号),后续 load 整包替换 items 时按版本 gate 叠加 learned(Bugbot)
      if (tip?.sourceId) locallyLearnedVersions.set(tip.sourceId, tip.version ?? 1);
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

// ── 账号切换 / 登出时清空 user-scoped 状态 ──
// locallyLearnedVersions 是模块级内存,跨账号切换(同一标签不刷新页面)不会自动清,
// 否则上个用户学会的共享 seed sourceId 会让下个用户的入口脉冲 / 自动开讲被错误压制(Bugbot High)。
// 同时复位 items/loaded/dismissed,避免残留上个用户的 tip(sessionStorage 在 logout 时也会被 clear)。
registerLogoutReset(() => {
  locallyLearnedVersions.clear();
  useDailyTipsStore.setState({ items: [], loaded: false, loading: false, dismissed: new Set() });
});

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
