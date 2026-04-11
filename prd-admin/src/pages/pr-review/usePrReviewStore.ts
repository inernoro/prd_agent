/**
 * PR Review V2 store —— 严格 SSOT，无 localStorage 持久化。
 *
 * 规则：
 * - 服务端是唯一真相源，关闭浏览器即清空状态
 * - 列表 / 详情 / 连接态都来自 API，不在前端建索引或缓存
 * - 错误只用一个 errorMessage 字段，不拆多个 channel
 */
import { create } from 'zustand';
import {
  getPrReviewAuthStatus,
  startPrReviewOAuth,
  disconnectPrReviewGitHub,
  listPrReviewItems,
  createPrReviewItem,
  refreshPrReviewItem,
  updatePrReviewItemNote,
  deletePrReviewItem,
  type PrReviewAuthStatus,
  type PrReviewItemDto,
} from '@/services/real/prReview';

interface PrReviewState {
  // 连接态
  authStatus: PrReviewAuthStatus | null;
  authLoading: boolean;

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
  connectGitHub: () => Promise<void>;
  disconnectGitHub: () => Promise<void>;
  loadItems: (page?: number) => Promise<void>;
  addItem: (pullRequestUrl: string, note?: string) => Promise<boolean>;
  refreshItem: (id: string) => Promise<void>;
  updateNote: (id: string, note: string | null) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  clearError: () => void;
}

export const usePrReviewStore = create<PrReviewState>((set, get) => ({
  authStatus: null,
  authLoading: false,
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

  connectGitHub: async () => {
    const res = await startPrReviewOAuth();
    if (res.success && res.data?.authorizeUrl) {
      // 整页跳转到 GitHub；后端回调后会再跳回到 /admin/pr-review?connected=1
      window.location.href = res.data.authorizeUrl;
    } else {
      set({ errorMessage: res.error?.message ?? '无法启动 GitHub 授权' });
    }
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
      // 刷新第一页列表
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

    // 乐观更新
    set((state) => ({
      items: state.items.map((it) => (it.id === id ? { ...it, note } : it)),
    }));

    const res = await updatePrReviewItemNote(id, note);

    const cleared = new Set(get().savingNoteIds);
    cleared.delete(id);
    set({ savingNoteIds: cleared });

    if (!res.success) {
      set({ errorMessage: res.error?.message ?? '笔记保存失败' });
      // 回滚：重新拉取列表
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
}));
