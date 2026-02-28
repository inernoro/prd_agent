import { create } from 'zustand';
import {
  listDefects,
  listDefectTemplates,
  getDefectUsers,
  getDefectStats,
} from '@/services';
import type {
  DefectReport,
  DefectTemplate,
  DefectUser,
  DefectStats,
} from '@/services/contracts/defectAgent';

type FilterType = 'submitted' | 'assigned' | 'all';
type ViewMode = 'card' | 'list';

const VIEW_MODE_STORAGE_KEY = 'defect-view-mode';
const READ_IDS_STORAGE_KEY = 'defect-read-ids';

function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return v === 'list' ? 'list' : 'card';
  } catch { return 'card'; }
}

function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_IDS_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveReadIds(ids: Set<string>) {
  try {
    localStorage.setItem(READ_IDS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

interface DefectState {
  // Data
  defects: DefectReport[];
  templates: DefectTemplate[];
  users: DefectUser[];
  stats: DefectStats | null;

  // UI State
  loading: boolean;
  error: string;
  filter: FilterType;
  statusFilter: string;
  selectedDefectId: string | null;
  showSubmitPanel: boolean;
  showTemplateDialog: boolean;
  viewMode: ViewMode;
  readIds: Set<string>;

  // Actions
  loadDefects: () => Promise<void>;
  loadTemplates: () => Promise<void>;
  loadUsers: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadAll: () => Promise<void>;

  setFilter: (filter: FilterType) => void;
  setStatusFilter: (status: string) => void;
  setSelectedDefectId: (id: string | null) => void;
  setShowSubmitPanel: (show: boolean) => void;
  setShowTemplateDialog: (show: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  markAsRead: (id: string) => void;
  isRead: (id: string) => boolean;

  // Update local state
  updateDefectInList: (defect: DefectReport) => void;
  removeDefectFromList: (id: string) => void;
  addDefectToList: (defect: DefectReport) => void;
  updateTemplateInList: (template: DefectTemplate) => void;
  removeTemplateFromList: (id: string) => void;
  addTemplateToList: (template: DefectTemplate) => void;

  reset: () => void;
}

export const useDefectStore = create<DefectState>((set, get) => ({
  // Initial state
  defects: [],
  templates: [],
  users: [],
  stats: null,
  loading: false,
  error: '',
  filter: 'assigned',
  statusFilter: '',
  selectedDefectId: null,
  showSubmitPanel: false,
  showTemplateDialog: false,
  viewMode: loadViewMode(),
  readIds: loadReadIds(),

  // Load defects
  loadDefects: async () => {
    const { filter, statusFilter } = get();
    set({ loading: true, error: '' });
    try {
      const res = await listDefects({
        filter,
        status: statusFilter || undefined,
        limit: 100,
      });
      if (res.success && res.data) {
        set({ defects: res.data.items, loading: false });
      } else {
        set({ error: res.error?.message || '加载失败', loading: false });
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  // Load templates
  loadTemplates: async () => {
    try {
      const res = await listDefectTemplates();
      if (res.success && res.data) {
        set({ templates: res.data.items });
      }
    } catch {
      // Silent fail for templates
    }
  },

  // Load users
  loadUsers: async () => {
    try {
      const res = await getDefectUsers();
      if (res.success && res.data) {
        set({ users: res.data.items });
      }
    } catch {
      // Silent fail for users
    }
  },

  // Load stats
  loadStats: async () => {
    try {
      const res = await getDefectStats();
      if (res.success && res.data) {
        set({ stats: res.data });
      }
    } catch {
      // Silent fail for stats
    }
  },

  // Load all data
  loadAll: async () => {
    const state = get();
    await Promise.all([
      state.loadDefects(),
      state.loadTemplates(),
      state.loadUsers(),
      state.loadStats(),
    ]);
  },

  // Setters
  setFilter: (filter) => {
    set({ filter });
    get().loadDefects();
  },

  setStatusFilter: (status) => {
    set({ statusFilter: status });
    get().loadDefects();
  },

  setSelectedDefectId: (id) => {
    set({ selectedDefectId: id });
    // 打开详情时自动标记为已读
    if (id) {
      get().markAsRead(id);
    }
  },
  setShowSubmitPanel: (show) => set({ showSubmitPanel: show }),
  setShowTemplateDialog: (show) => set({ showTemplateDialog: show }),
  setViewMode: (mode) => {
    set({ viewMode: mode });
    try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
  },
  markAsRead: (id) => {
    const { readIds } = get();
    if (readIds.has(id)) return;
    const next = new Set(readIds);
    next.add(id);
    set({ readIds: next });
    saveReadIds(next);
  },
  isRead: (id) => get().readIds.has(id),

  // Update helpers
  updateDefectInList: (defect) => {
    set((state) => ({
      defects: state.defects.map((d) => (d.id === defect.id ? defect : d)),
    }));
  },

  removeDefectFromList: (id) => {
    set((state) => ({
      defects: state.defects.filter((d) => d.id !== id),
      selectedDefectId: state.selectedDefectId === id ? null : state.selectedDefectId,
    }));
  },

  addDefectToList: (defect) => {
    set((state) => ({
      defects: [defect, ...state.defects],
    }));
  },

  updateTemplateInList: (template) => {
    set((state) => ({
      templates: state.templates.map((t) => (t.id === template.id ? template : t)),
    }));
  },

  removeTemplateFromList: (id) => {
    set((state) => ({
      templates: state.templates.filter((t) => t.id !== id),
    }));
  },

  addTemplateToList: (template) => {
    set((state) => ({
      templates: [template, ...state.templates],
    }));
  },

  reset: () => {
    set({
      defects: [],
      templates: [],
      users: [],
      stats: null,
      loading: false,
      error: '',
      filter: 'submitted',
      statusFilter: '',
      selectedDefectId: null,
      showSubmitPanel: false,
      showTemplateDialog: false,
      viewMode: loadViewMode(),
      readIds: loadReadIds(),
    });
  },
}));
