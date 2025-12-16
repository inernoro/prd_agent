import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { ApiResponse, Group } from '../types';

interface GroupListState {
  groups: Group[];
  loading: boolean;
  loadGroups: () => Promise<void>;
  clear: () => void;
}

export const useGroupListStore = create<GroupListState>((set) => ({
  groups: [],
  loading: false,

  loadGroups: async () => {
    set({ loading: true });
    try {
      const response = await invoke<ApiResponse<Group[]>>('get_groups');
      if (response.success && response.data) {
        set({ groups: response.data });
      } else {
        set({ groups: [] });
      }
    } catch (err) {
      console.error('Failed to load groups:', err);
      set({ groups: [] });
    } finally {
      set({ loading: false });
    }
  },

  clear: () => set({ groups: [], loading: false }),
}));


