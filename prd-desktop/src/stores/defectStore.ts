import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import type { ApiResponse, DefectReport, DefectMessage, DefectStats } from '../types';

interface DefectState {
  defects: DefectReport[];
  stats: DefectStats | null;
  loading: boolean;
  selectedDefectId: string | null;
  selectedDefect: DefectReport | null;
  defectMessages: DefectMessage[];
  showSubmitPanel: boolean;

  loadDefects: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadDefect: (id: string) => Promise<void>;
  loadDefectMessages: (id: string, afterSeq?: number) => Promise<void>;
  setSelectedDefectId: (id: string | null) => void;
  setShowSubmitPanel: (show: boolean) => void;
  addDefectToList: (defect: DefectReport) => void;
  updateDefectInList: (defect: DefectReport) => void;
  clear: () => void;
}

export const useDefectStore = create<DefectState>((set) => ({
  defects: [],
  stats: null,
  loading: false,
  selectedDefectId: null,
  selectedDefect: null,
  defectMessages: [],
  showSubmitPanel: false,

  loadDefects: async () => {
    set({ loading: true });
    try {
      const resp = await invoke<ApiResponse<{ items: DefectReport[] }>>('list_defects');
      if (resp.success && resp.data) {
        // Backend may return items as array directly or wrapped
        const items = Array.isArray(resp.data) ? resp.data : (resp.data.items ?? []);
        set({ defects: items as DefectReport[] });
      }
    } catch (err) {
      console.error('Failed to load defects:', err);
    } finally {
      set({ loading: false });
    }
  },

  loadStats: async () => {
    try {
      const resp = await invoke<ApiResponse<DefectStats>>('get_defect_stats');
      if (resp.success && resp.data) {
        set({ stats: resp.data });
      }
    } catch (err) {
      console.error('Failed to load defect stats:', err);
    }
  },

  loadDefect: async (id) => {
    try {
      const resp = await invoke<ApiResponse<{ defect: DefectReport; messages: DefectMessage[] }>>('get_defect', { id });
      if (resp.success && resp.data) {
        const data = resp.data as any;
        const defect = data.defect ?? data;
        const messages = data.messages ?? [];
        set({ selectedDefect: defect, defectMessages: messages });
      }
    } catch (err) {
      console.error('Failed to load defect:', err);
    }
  },

  loadDefectMessages: async (id, afterSeq) => {
    try {
      const resp = await invoke<ApiResponse<{ messages: DefectMessage[] }>>('get_defect_messages', { id, afterSeq: afterSeq ?? null });
      if (resp.success && resp.data) {
        const messages = Array.isArray(resp.data) ? resp.data : (resp.data as any).messages ?? [];
        if (afterSeq && afterSeq > 0) {
          // 增量追加
          set((state) => ({
            defectMessages: [...state.defectMessages, ...(messages as DefectMessage[])],
          }));
        } else {
          set({ defectMessages: messages as DefectMessage[] });
        }
      }
    } catch (err) {
      console.error('Failed to load defect messages:', err);
    }
  },

  setSelectedDefectId: (id) => set({ selectedDefectId: id }),
  setShowSubmitPanel: (show) => set({ showSubmitPanel: show }),

  addDefectToList: (defect) => set((state) => ({
    defects: [defect, ...state.defects],
  })),

  updateDefectInList: (defect) => set((state) => ({
    defects: state.defects.map((d) => d.id === defect.id ? defect : d),
    selectedDefect: state.selectedDefect?.id === defect.id ? defect : state.selectedDefect,
  })),

  clear: () => set({
    defects: [],
    stats: null,
    loading: false,
    selectedDefectId: null,
    selectedDefect: null,
    defectMessages: [],
    showSubmitPanel: false,
  }),
}));
