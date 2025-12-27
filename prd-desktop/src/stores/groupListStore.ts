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
      const runOnce = async () => {
        const response = await invoke<ApiResponse<Group[]>>('get_groups');
        if (response.success && response.data) {
          set({ groups: response.data });
          return { ok: true as const, code: null as string | null };
        }
        return { ok: false as const, code: response.error?.code ?? null };
      };

      const first = await runOnce();
      if (!first.ok && first.code === 'UNAUTHORIZED') {
        // 启动/登录瞬间可能存在并发请求竞态：短暂 401 不应立刻 logout（会造成“闪一下回登录”）。
        // 做一次轻量重试，给 Rust 自动 refresh / token 同步留出时间。
        await new Promise((r) => setTimeout(r, 600));
        const second = await runOnce();
        if (!second.ok) {
          if (second.code === 'UNAUTHORIZED') {
            // 两次仍 401：基本可判定为 token 失效/会话不可用，回到登录页让用户重新登录。
            // 这里不弹系统错误弹窗（invoke 层已忽略 UNAUTHORIZED），避免“登录报错”体验。
            useAuthStore.getState().logout();
            set({ groups: [] });
            return;
          }
          set({ groups: [] });
        }
        return;
      }
      if (!first.ok) {
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


