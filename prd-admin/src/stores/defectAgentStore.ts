import { create } from 'zustand';
import type {
  DefectReport,
  DefectReview,
  DefectFix,
  DefectStats,
  CreateDefectInput,
  UpdateDefectInput,
} from '@/services/contracts/defectAgent';
import {
  listDefectsReal,
  getDefectReal,
  createDefectReal,
  updateDefectReal,
  deleteDefectReal,
  submitDefectReal,
  triggerFixReal,
  verifyFixReal,
  closeDefectReal,
  reopenDefectReal,
  getReviewsReal,
  getFixesReal,
  getDefectStatsReal,
} from '@/services/real/defectAgent';

export type DefectViewMode = 'kanban' | 'list';

export type DefectFilter = {
  status?: string;
  priority?: string;
  search?: string;
};

type DefectAgentState = {
  // List
  defects: DefectReport[];
  total: number;
  loading: boolean;
  filter: DefectFilter;
  viewMode: DefectViewMode;

  // Detail
  currentDefect: DefectReport | null;
  currentReviews: DefectReview[];
  currentFixes: DefectFix[];
  detailLoading: boolean;

  // Stats
  stats: DefectStats | null;

  // SSE
  activeRunId: string | null;

  // Actions
  setFilter: (filter: DefectFilter) => void;
  setViewMode: (mode: DefectViewMode) => void;
  fetchDefects: (params?: { offset?: number; limit?: number }) => Promise<void>;
  fetchDefectDetail: (id: string) => Promise<void>;
  createDefect: (input: CreateDefectInput) => Promise<string | null>;
  updateDefect: (id: string, input: UpdateDefectInput) => Promise<boolean>;
  deleteDefect: (id: string) => Promise<boolean>;
  submitDefect: (id: string) => Promise<string | null>;
  triggerFix: (id: string) => Promise<string | null>;
  verifyFix: (id: string) => Promise<boolean>;
  closeDefect: (id: string) => Promise<boolean>;
  reopenDefect: (id: string) => Promise<boolean>;
  fetchStats: () => Promise<void>;
  setActiveRunId: (runId: string | null) => void;
};

export const useDefectAgentStore = create<DefectAgentState>((set, get) => ({
  defects: [],
  total: 0,
  loading: false,
  filter: {},
  viewMode: 'list',

  currentDefect: null,
  currentReviews: [],
  currentFixes: [],
  detailLoading: false,

  stats: null,
  activeRunId: null,

  setFilter: (filter) => set({ filter }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setActiveRunId: (runId) => set({ activeRunId: runId }),

  fetchDefects: async (params) => {
    set({ loading: true });
    try {
      const { filter } = get();
      const res = await listDefectsReal({
        status: filter.status,
        priority: filter.priority,
        limit: params?.limit ?? 50,
        offset: params?.offset ?? 0,
      });
      if (res.success && res.data) {
        set({ defects: res.data.items, total: res.data.total });
      }
    } finally {
      set({ loading: false });
    }
  },

  fetchDefectDetail: async (id) => {
    set({ detailLoading: true, currentDefect: null, currentReviews: [], currentFixes: [] });
    try {
      const [defectRes, reviewsRes, fixesRes] = await Promise.all([
        getDefectReal(id),
        getReviewsReal(id),
        getFixesReal(id),
      ]);
      if (defectRes.success && defectRes.data) {
        set({ currentDefect: defectRes.data.defect });
      }
      if (reviewsRes.success && reviewsRes.data) {
        set({ currentReviews: reviewsRes.data.reviews });
      }
      if (fixesRes.success && fixesRes.data) {
        set({ currentFixes: fixesRes.data.fixes });
      }
    } finally {
      set({ detailLoading: false });
    }
  },

  createDefect: async (input) => {
    const res = await createDefectReal(input);
    if (res.success && res.data) {
      return res.data.defect.id;
    }
    return null;
  },

  updateDefect: async (id, input) => {
    const res = await updateDefectReal(id, input);
    if (res.success && res.data) {
      set({ currentDefect: res.data.defect });
      return true;
    }
    return false;
  },

  deleteDefect: async (id) => {
    const res = await deleteDefectReal(id);
    return res.success === true;
  },

  submitDefect: async (id) => {
    const res = await submitDefectReal(id);
    if (res.success && res.data) {
      set({ activeRunId: res.data.runId });
      return res.data.runId;
    }
    return null;
  },

  triggerFix: async (id) => {
    const res = await triggerFixReal(id);
    if (res.success && res.data) {
      set({ activeRunId: res.data.runId });
      return res.data.runId;
    }
    return null;
  },

  verifyFix: async (id) => {
    const res = await verifyFixReal(id);
    return res.success === true;
  },

  closeDefect: async (id) => {
    const res = await closeDefectReal(id);
    return res.success === true;
  },

  reopenDefect: async (id) => {
    const res = await reopenDefectReal(id);
    return res.success === true;
  },

  fetchStats: async () => {
    const res = await getDefectStatsReal();
    if (res.success && res.data) {
      set({ stats: res.data });
    }
  },
}));
