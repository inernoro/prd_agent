import { create } from 'zustand';
import type { DailyTip, TutorialProgress } from '@/services/real/dailyTips';
import { listVisibleTips, markTipAsLearned, getTutorialProgress } from '@/services/real/dailyTips';
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
  /** 学习进度(头像进度环 + 学习中心页),null=未加载 */
  progress: TutorialProgress | null;
  /** 首次加载。已加载时默认不重复;force=true 时强制重拉(用于轮询 / 可见性变化)。 */
  load: (opts?: { force?: boolean }) => Promise<void>;
  /** 拉取学习进度(头像环 / 学习中心)。force=true 强制重拉。 */
  loadProgress: (opts?: { force?: boolean }) => Promise<void>;
  dismiss: (id: string) => void;
  /** 标记某条 tip 为「已学会」:服务端写 (SourceId, Version) + 本地立即移除。 */
  markLearned: (id: string) => Promise<void>;
  /** 「text」类 tip(副标题轮播使用) */
  textTips: () => DailyTip[];
  /** 「card」/「spotlight」类 tip(右下抽屉使用),已自动过滤 session 关闭项 */
  cardTips: () => DailyTip[];
}

/** loadProgress 的模块级在途请求(仅 non-force),用于并发去重(见 loadProgress 注释)。 */
let progressInFlight: Promise<void> | null = null;
/** 单调递增的请求序号:只有「最新发起」的请求才允许落库,防止更早发出、更晚返回的请求覆盖新数据。 */
let progressReqSeq = 0;
/** 当前 progressInFlight 的归属序号,用于在结束时只清理「确实是自己」占用的在途槽。 */
let progressInFlightSeq = 0;

export const useDailyTipsStore = create<DailyTipsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  dismissed: readDismissed(),
  progress: null,

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

  async loadProgress(opts) {
    if (get().progress && !opts?.force) return;
    // 并发去重:冷启动多组件(如首页三套教程承接卡)同时挂载会各调一次 loadProgress,
    // 仅靠 progress==null 判空挡不住「请求在途」的并发,会打出多发 getTutorialProgress(Bugbot)。
    // 仅对 non-force 复用在途请求;force 必须发新请求 —— 否则 markLearned 后的权威校正会复用
    // 更早的请求,拿回「学会前」的旧 XP/掌握度(Bugbot Medium / Codex P2)。
    if (!opts?.force && progressInFlight) return progressInFlight;
    const seq = ++progressReqSeq;
    const p = (async () => {
      try {
        const res = await getTutorialProgress();
        // 只有「本次是最新发起的请求」才落库:挡住更早发出、更晚返回的请求覆盖新数据
        // (并发 stale overwrite / 账号切换串数据 / force 被在途旧请求压回)。
        if (seq === progressReqSeq && res.success && res.data) set({ progress: res.data });
      } catch {
        /* 进度拉取失败不阻塞 UI(头像环只是不显示) */
      } finally {
        // 仅当在途槽仍属于本次请求时才清空(用序号判定归属,避免引用尚未赋值的 p)。
        if (progressInFlightSeq === seq) progressInFlight = null;
      }
    })();
    if (!opts?.force) {
      progressInFlight = p;
      progressInFlightSeq = seq;
    }
    return p;
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
    // 记进本会话乐观学会版本(sourceId → 学会时版本号),后续 load 整包替换 items 时按版本 gate 叠加 learned。
    // page-guide 与非 page-guide 都记:成功落库后服务端是权威源(非 page-guide 被 FilterLearned 移除、不会再回显);
    // 但若 markLearned 请求失败、稍后某次 load 又把它当「未学会」拉回,applyLocalLearned 会按版本 gate 重新叠加
    // learned —— 避免「轻微提醒更新 sessionStorage 已锁(本会话不再自动弹)却被恢复成未学会」的不一致
    // (Bugbot: Reminder session lock before learn)。版本被 admin bump 时不压制,教程仍正常重现。
    if (tip?.sourceId) locallyLearnedVersions.set(tip.sourceId, tip.version ?? 1);
    if (isPageGuide) {
      set({ items: get().items.map((t) => (t.id === id ? { ...t, learned: true } : t)) });
    } else {
      set({ items: get().items.filter((t) => t.id !== id) });
    }
    // 乐观更新进度环:把这条 sourceId 标 learned,onboarding 计数 +1(避免等服务端 round-trip 才填环)
    const sid = tip?.sourceId;
    if (sid) {
      const prog = get().progress;
      if (prog) {
        let changed = false;
        const items = prog.items.map((it) => {
          if (it.sourceId === sid && !it.learned) { changed = true; return { ...it, learned: true }; }
          return it;
        });
        const wasOnboardingUnlearned =
          changed && prog.items.some((it) => it.sourceId === sid && it.category === 'onboarding');
        set({
          progress: {
            ...prog,
            items,
            learned: prog.learned + (wasOnboardingUnlearned ? 1 : 0),
          },
        });
      }
    }
    try {
      await markTipAsLearned(id);
      // 服务端落库后用权威值校正(避免乐观计数与真实值漂移)
      void get().loadProgress({ force: true });
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
  // 复位进度请求去重态:nulling 在途 + bump seq,让上个用户在途的 getTutorialProgress
  // 既不会被下个用户复用,返回后也因 seq 失配被丢弃(Bugbot High:跨账号串教程进度)。
  progressInFlight = null;
  progressReqSeq++;
  useDailyTipsStore.setState({ items: [], loaded: false, loading: false, dismissed: new Set(), progress: null });
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
