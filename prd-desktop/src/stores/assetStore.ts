import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import type { ApiResponse, AssetItem, AssetType, MyAssetsResponse } from '../types';

export type AssetTab = 'all' | AssetType;
export type AssetSortBy = 'date' | 'size' | 'name';
export type AssetViewMode = 'grid' | 'list';

const PAGE_SIZE = 30;

interface AssetStore {
  // Data
  items: AssetItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;

  // Filters & sort
  activeTab: AssetTab;
  searchQuery: string;
  sortBy: AssetSortBy;
  sortDesc: boolean;

  // View
  viewMode: AssetViewMode;
  selectedId: string | null;

  // Actions
  setActiveTab: (tab: AssetTab) => void;
  setSearchQuery: (q: string) => void;
  setSortBy: (s: AssetSortBy) => void;
  toggleSortOrder: () => void;
  setViewMode: (m: AssetViewMode) => void;
  selectAsset: (id: string | null) => void;

  fetchAssets: () => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

// Restore view preference from localStorage
function readViewMode(): AssetViewMode {
  try {
    const v = localStorage.getItem('prd-assets-view');
    if (v === 'list') return 'list';
  } catch { /* ignore */ }
  return 'grid';
}

export const useAssetStore = create<AssetStore>((set, get) => ({
  items: [],
  total: 0,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,

  activeTab: 'all',
  searchQuery: '',
  sortBy: 'date',
  sortDesc: true,

  viewMode: readViewMode(),
  selectedId: null,

  setActiveTab: (tab) => {
    set({ activeTab: tab, items: [], total: 0, hasMore: false, selectedId: null });
    get().fetchAssets();
  },

  setSearchQuery: (q) => set({ searchQuery: q }),

  setSortBy: (s) => {
    const current = get().sortBy;
    if (current === s) {
      // Same column → toggle order
      set((st) => ({ sortDesc: !st.sortDesc }));
    } else {
      set({ sortBy: s, sortDesc: s === 'date' }); // date defaults to desc
    }
  },

  toggleSortOrder: () => set((st) => ({ sortDesc: !st.sortDesc })),

  setViewMode: (m) => {
    set({ viewMode: m });
    try { localStorage.setItem('prd-assets-view', m); } catch { /* ignore */ }
  },

  selectAsset: (id) => set({ selectedId: id }),

  fetchAssets: async () => {
    set({ loading: true, error: null });
    try {
      const { activeTab } = get();
      const category = activeTab === 'all' ? undefined : activeTab;
      const resp = await invoke<ApiResponse<MyAssetsResponse>>('get_my_assets', {
        category: category ?? null,
        limit: PAGE_SIZE,
        skip: 0,
      });
      if (resp?.success && resp.data) {
        set({
          items: resp.data.items,
          total: resp.data.total,
          hasMore: resp.data.hasMore,
          loading: false,
        });
      } else {
        set({ error: resp?.error?.message ?? '加载失败', loading: false });
      }
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  loadMore: async () => {
    const { hasMore, loadingMore, items, activeTab } = get();
    if (!hasMore || loadingMore) return;
    set({ loadingMore: true });
    try {
      const category = activeTab === 'all' ? undefined : activeTab;
      const resp = await invoke<ApiResponse<MyAssetsResponse>>('get_my_assets', {
        category: category ?? null,
        limit: PAGE_SIZE,
        skip: items.length,
      });
      if (resp?.success && resp.data) {
        set({
          items: [...items, ...resp.data.items],
          total: resp.data.total,
          hasMore: resp.data.hasMore,
          loadingMore: false,
        });
      } else {
        set({ loadingMore: false });
      }
    } catch {
      set({ loadingMore: false });
    }
  },

  refresh: async () => {
    set({ items: [], total: 0, hasMore: false, selectedId: null });
    await get().fetchAssets();
  },
}));
