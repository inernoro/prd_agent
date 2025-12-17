import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import type { ApiResponse, Group } from '../types';
import { useAuthStore } from './authStore';

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
    // 演示模式不依赖后端，也不加载群组列表
    const demoUserId = useAuthStore.getState().user?.userId;
    if (demoUserId === 'demo-user-001') {
      set({ groups: [], loading: false });
      return;
    }

    set({ loading: true });
    try {
      const response = await invoke<ApiResponse<Group[]>>('get_groups');
      if (response.success && response.data) {
        set({ groups: response.data });
      } else {
        // token 失效：强制退出，让用户重新登录拿新 token
        if (response.error?.code === 'UNAUTHORIZED') {
          useAuthStore.getState().logout();
          set({ groups: [] });
          return;
        }
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


