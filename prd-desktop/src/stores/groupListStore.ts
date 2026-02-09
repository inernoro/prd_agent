import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import type { ApiResponse, Group } from '../types';
import { useAuthStore } from './authStore';

interface GroupListState {
  groups: Group[];
  /** 仅首次加载时为 true（触发骨架屏），后台刷新不设置 */
  loading: boolean;
  loadGroups: (opts?: { force?: boolean; silent?: boolean }) => Promise<void>;
  /** 直接添加一个群组到列表（避免全量刷新导致 loading 闪烁） */
  addGroup: (group: Group) => void;
  /** 更新指定群组的名称（用于后台 AI 生成群名后静默更新） */
  updateGroupName: (groupId: string, name: string) => void;
  clear: () => void;
}

export const useGroupListStore = create<GroupListState>((set, get) => ({
  groups: [],
  loading: false,

  loadGroups: async (opts) => {
    const force = opts?.force ?? false;
    const silent = opts?.silent ?? false;
    // 防止并发调用（特别是 StrictMode 下的双重调用）
    // force=true 时允许绕过检查（用于创建群组后强制刷新）
    if (!force && get().loading) return;
    // silent 模式：后台刷新不触发 loading，避免 ChatContainer 卸载/重挂造成闪烁
    if (!silent) {
      set({ loading: true });
    }
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
        await new Promise((r) => setTimeout(r, 600));
        const second = await runOnce();
        if (!second.ok) {
          if (second.code === 'UNAUTHORIZED') {
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
      if (!silent) {
        set({ loading: false });
      }
    }
  },

  addGroup: (group) => set((state) => ({
    groups: [group, ...state.groups],
  })),

  updateGroupName: (groupId, name) => set((state) => ({
    groups: state.groups.map((g) =>
      g.groupId === groupId ? { ...g, groupName: name } : g
    ),
  })),

  clear: () => set({ groups: [], loading: false }),
}));
