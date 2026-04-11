/**
 * PR Review V2 store —— 严格 SSOT，无 localStorage 持久化。
 *
 * 授权模式：GitHub Device Flow（RFC 8628）
 * - 用户点"连接 GitHub" → 调 startDeviceFlow → 拿到 userCode + verificationUriComplete
 * - 前端展示 userCode 并弹开 verificationUriComplete 让用户授权
 * - 自动启动轮询循环：按 intervalSeconds 调 pollDeviceFlow
 * - 直到 status === 'done'（刷新 auth 状态）/ 'expired' / 'denied'（显示错误）
 *
 * 规则：
 * - 服务端是唯一真相源，关闭浏览器即清空状态
 * - 列表 / 详情 / 连接态都来自 API，不在前端建索引或缓存
 * - 错误只用一个 errorMessage 字段，不拆多个 channel
 */
import { create } from 'zustand';
import {
  getPrReviewAuthStatus,
  startPrReviewDeviceFlow,
  pollPrReviewDeviceFlow,
  disconnectPrReviewGitHub,
  listPrReviewItems,
  createPrReviewItem,
  refreshPrReviewItem,
  updatePrReviewItemNote,
  deletePrReviewItem,
  type PrReviewAuthStatus,
  type PrReviewItemDto,
  type PrAlignmentReportDto,
  type PrSummaryReportDto,
} from '@/services/real/prReview';

export interface DeviceFlowState {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  flowToken: string;
  intervalSeconds: number;
  startedAt: number;          // Date.now() 的毫秒时间戳，用于倒计时
  expiresInSeconds: number;
  polling: boolean;           // true 时正在轮询
  status: 'idle' | 'polling' | 'expired' | 'denied' | 'failed';
  errorDetail?: string;
}

interface PrReviewState {
  // 连接态
  authStatus: PrReviewAuthStatus | null;
  authLoading: boolean;

  // Device Flow 进行中状态
  deviceFlow: DeviceFlowState | null;

  // 列表
  items: PrReviewItemDto[];
  total: number;
  page: number;
  pageSize: number;
  listLoading: boolean;

  // 错误
  errorMessage: string | null;

  // per-item UI 状态（刷新中/保存笔记中）
  refreshingIds: Set<string>;
  savingNoteIds: Set<string>;

  // 操作
  loadAuthStatus: () => Promise<void>;
  startConnect: () => Promise<void>;
  cancelDeviceFlow: () => void;
  disconnectGitHub: () => Promise<void>;
  loadItems: (page?: number) => Promise<void>;
  addItem: (pullRequestUrl: string, note?: string) => Promise<boolean>;
  refreshItem: (id: string) => Promise<void>;
  updateNote: (id: string, note: string | null) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  clearError: () => void;
  /** 档 3：SSE 流式对齐分析完成后，由组件回传最终结果，更新列表里的 item */
  setAlignmentReport: (id: string, report: PrAlignmentReportDto) => void;
  /** 档 1：SSE 流式摘要完成后，由组件回传最终结果，更新列表里的 item */
  setSummaryReport: (id: string, report: PrSummaryReportDto) => void;
}

// 轮询循环的内部句柄；不放进 store 以避免触发 React 重渲
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function clearPollTimer() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export const usePrReviewStore = create<PrReviewState>((set, get) => ({
  authStatus: null,
  authLoading: false,
  deviceFlow: null,
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  listLoading: false,
  errorMessage: null,
  refreshingIds: new Set(),
  savingNoteIds: new Set(),

  loadAuthStatus: async () => {
    set({ authLoading: true });
    const res = await getPrReviewAuthStatus();
    if (res.success && res.data) {
      set({ authStatus: res.data, authLoading: false });
    } else {
      set({ authLoading: false, errorMessage: res.error?.message ?? '连接状态加载失败' });
    }
  },

  startConnect: async () => {
    // 清理上一轮遗留状态
    clearPollTimer();
    set({ deviceFlow: null, errorMessage: null });

    const res = await startPrReviewDeviceFlow();
    if (!res.success || !res.data) {
      set({ errorMessage: res.error?.message ?? '无法发起 GitHub 授权' });
      return;
    }

    const data = res.data;
    const flow: DeviceFlowState = {
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      flowToken: data.flowToken,
      intervalSeconds: data.intervalSeconds,
      startedAt: Date.now(),
      expiresInSeconds: data.expiresInSeconds,
      polling: true,
      status: 'polling',
    };
    set({ deviceFlow: flow });

    // 自动弹开 GitHub 授权页（可能被浏览器弹窗拦截——前端 UI 同时提供"再次打开"按钮兜底）
    try {
      window.open(data.verificationUriComplete, '_blank', 'noopener,noreferrer');
    } catch {
      // 忽略：UI 里有备用按钮
    }

    // 启动轮询
    schedulePoll(set, get);
  },

  cancelDeviceFlow: () => {
    clearPollTimer();
    set({ deviceFlow: null });
  },

  disconnectGitHub: async () => {
    const res = await disconnectPrReviewGitHub();
    if (res.success) {
      await get().loadAuthStatus();
    } else {
      set({ errorMessage: res.error?.message ?? '断开连接失败' });
    }
  },

  loadItems: async (page?: number) => {
    const { pageSize } = get();
    const nextPage = page ?? get().page;
    set({ listLoading: true });
    const res = await listPrReviewItems(nextPage, pageSize);
    if (res.success && res.data) {
      set({
        items: res.data.items,
        total: res.data.total,
        page: res.data.page,
        pageSize: res.data.pageSize,
        listLoading: false,
      });
    } else {
      set({ listLoading: false, errorMessage: res.error?.message ?? '列表加载失败' });
    }
  },

  addItem: async (pullRequestUrl, note) => {
    set({ errorMessage: null });
    const res = await createPrReviewItem(pullRequestUrl, note);
    if (res.success && res.data) {
      await get().loadItems(1);
      return true;
    }
    set({ errorMessage: res.error?.message ?? '添加 PR 失败' });
    return false;
  },

  refreshItem: async (id) => {
    const next = new Set(get().refreshingIds);
    next.add(id);
    set({ refreshingIds: next });

    const res = await refreshPrReviewItem(id);

    const cleared = new Set(get().refreshingIds);
    cleared.delete(id);
    set({ refreshingIds: cleared });

    if (res.success && res.data) {
      set((state) => ({
        items: state.items.map((it) => (it.id === id ? res.data! : it)),
      }));
    } else {
      set({ errorMessage: res.error?.message ?? '刷新失败' });
    }
  },

  updateNote: async (id, note) => {
    const next = new Set(get().savingNoteIds);
    next.add(id);
    set({ savingNoteIds: next });

    set((state) => ({
      items: state.items.map((it) => (it.id === id ? { ...it, note } : it)),
    }));

    const res = await updatePrReviewItemNote(id, note);

    const cleared = new Set(get().savingNoteIds);
    cleared.delete(id);
    set({ savingNoteIds: cleared });

    if (!res.success) {
      set({ errorMessage: res.error?.message ?? '笔记保存失败' });
      await get().loadItems();
    }
  },

  deleteItem: async (id) => {
    const res = await deletePrReviewItem(id);
    if (res.success) {
      set((state) => ({
        items: state.items.filter((it) => it.id !== id),
        total: Math.max(0, state.total - 1),
      }));
    } else {
      set({ errorMessage: res.error?.message ?? '删除失败' });
    }
  },

  clearError: () => set({ errorMessage: null }),

  setAlignmentReport: (id, report) => {
    set((state) => ({
      items: state.items.map((it) => (it.id === id ? { ...it, alignmentReport: report } : it)),
    }));
  },

  setSummaryReport: (id, report) => {
    set((state) => ({
      items: state.items.map((it) => (it.id === id ? { ...it, summaryReport: report } : it)),
    }));
  },
}));

/**
 * 调度下一次轮询：按 deviceFlow.intervalSeconds 节奏调用后端 poll 端点，
 * 根据返回 status 决定停止、继续、还是调大间隔。
 */
function schedulePoll(
  set: (partial: Partial<PrReviewState> | ((s: PrReviewState) => Partial<PrReviewState>)) => void,
  get: () => PrReviewState,
) {
  clearPollTimer();
  const flow = get().deviceFlow;
  if (!flow || flow.status !== 'polling') return;

  pollTimer = setTimeout(async () => {
    const current = get().deviceFlow;
    if (!current || current.status !== 'polling') return;

    // 检查本地超时：比后端返回的 expired 更快终止，避免用户看到"卡住"
    const elapsedSec = (Date.now() - current.startedAt) / 1000;
    if (elapsedSec > current.expiresInSeconds) {
      set({
        deviceFlow: { ...current, polling: false, status: 'expired' },
        errorMessage: '授权已超时，请重新发起连接',
      });
      return;
    }

    const res = await pollPrReviewDeviceFlow(current.flowToken);
    if (!res.success || !res.data) {
      set({
        deviceFlow: {
          ...current,
          polling: false,
          status: 'failed',
          errorDetail: res.error?.message,
        },
        errorMessage: res.error?.message ?? '授权轮询失败',
      });
      return;
    }

    switch (res.data.status) {
      case 'pending':
        schedulePoll(set, get);
        return;
      case 'slow_down':
        // GitHub 要求调大间隔，追加 5 秒
        set({
          deviceFlow: {
            ...current,
            intervalSeconds: current.intervalSeconds + 5,
          },
        });
        schedulePoll(set, get);
        return;
      case 'done': {
        clearPollTimer();
        set({ deviceFlow: null });
        // 刷新连接状态 + 列表
        await get().loadAuthStatus();
        await get().loadItems(1);
        return;
      }
      case 'expired':
        clearPollTimer();
        set({
          deviceFlow: { ...current, polling: false, status: 'expired' },
          errorMessage: '授权已超时，请重新发起连接',
        });
        return;
      case 'denied':
        clearPollTimer();
        set({
          deviceFlow: { ...current, polling: false, status: 'denied' },
          errorMessage: '你在 GitHub 页面拒绝了授权',
        });
        return;
    }
  }, Math.max(1, get().deviceFlow?.intervalSeconds ?? 5) * 1000);
}
