import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import type { ApiResponse, UserRole } from '../types';

type DirectoryUser = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
};

type GroupMemberInfo = {
  userId: string;
  username: string;
  displayName: string;
  memberRole: string;
};

function normalizeRole(raw: unknown): UserRole | null {
  const r = String(raw || '').trim().toUpperCase();
  if (r === 'PM' || r === 'DEV' || r === 'QA' || r === 'ADMIN') return r as UserRole;
  return null;
}

function normalizeUser(u: GroupMemberInfo): DirectoryUser | null {
  const userId = String(u?.userId || '').trim();
  if (!userId) return null;
  const username = String(u?.username || '').trim();
  const displayName = String(u?.displayName || '').trim();
  const role = normalizeRole((u as any)?.memberRole) ?? 'PM';
  return { userId, username, displayName, role };
}

type State = {
  byId: Record<string, DirectoryUser>;
  loadedGroupAt: Record<string, number>;
  loadGroupMembers: (groupId: string) => Promise<void>;
  resolveUsername: (userId?: string | null) => string | null;
  resolveRole: (userId?: string | null) => UserRole | null;
};

export const useUserDirectoryStore = create<State>((set, get) => ({
  byId: {},
  loadedGroupAt: {},

  loadGroupMembers: async (groupId) => {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    // 简单缓存：同一群 60s 内不重复拉取
    const now = Date.now();
    const last = get().loadedGroupAt[gid] ?? 0;
    if (now - last < 60_000) return;

    const resp = await invoke<ApiResponse<GroupMemberInfo[]>>('get_group_members', { groupId: gid });
    if (!resp?.success || !Array.isArray(resp.data)) {
      set((s) => ({ loadedGroupAt: { ...s.loadedGroupAt, [gid]: now } }));
      return;
    }

    const nextById: Record<string, DirectoryUser> = { ...get().byId };
    for (const m of resp.data) {
      const nu = normalizeUser(m);
      if (!nu) continue;
      nextById[nu.userId] = nu;
    }

    set((s) => ({
      byId: nextById,
      loadedGroupAt: { ...s.loadedGroupAt, [gid]: now },
    }));
  },

  resolveUsername: (userId) => {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    const u = get().byId[uid];
    if (!u) return null;
    // 你要求“显示用户名而不是 id”
    const name = (u.username || u.displayName || '').trim();
    return name || null;
  },

  resolveRole: (userId) => {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    const u = get().byId[uid];
    return u?.role ?? null;
  },
}));


