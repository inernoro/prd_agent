import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import type { ApiResponse, GroupMemberTag, UserRole } from '../types';

type DirectoryUser = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  tags?: GroupMemberTag[];
  avatarUrl?: string | null;
  avatarFileName?: string | null;
};

type GroupMemberInfo = {
  userId: string;
  username: string;
  displayName: string;
  memberRole: string;
  tags?: GroupMemberTag[] | null;
  avatarUrl?: string | null;
  avatarFileName?: string | null;
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
  const tags = Array.isArray((u as any)?.tags) ? ((u as any).tags as GroupMemberTag[]) : undefined;
  const avatarUrl = typeof (u as any)?.avatarUrl === 'string' ? String((u as any).avatarUrl) : null;
  const avatarFileName = typeof (u as any)?.avatarFileName === 'string' ? String((u as any).avatarFileName) : null;
  return { userId, username, displayName, role, tags, avatarUrl, avatarFileName };
}

type State = {
  byId: Record<string, DirectoryUser>;
  loadedGroupAt: Record<string, number>;
  loadGroupMembers: (groupId: string, opts?: { force?: boolean }) => Promise<void>;
  resolveUsername: (userId?: string | null) => string | null;
  resolveRole: (userId?: string | null) => UserRole | null;
  resolveUser: (userId?: string | null) => DirectoryUser | null;
  /**
   * 当流式事件没有 senderId/senderName 时，按当前 viewRole 推断“对应的机器人成员”。
   * 约定：群成员 tags 中存在 role=robot 的标签，且 name 通常为“测试/开发/产品”等。
   */
  resolveRobotForViewRole: (viewRole?: UserRole | null) => DirectoryUser | null;
};

export const useUserDirectoryStore = create<State>((set, get) => ({
  byId: {},
  loadedGroupAt: {},

  loadGroupMembers: async (groupId, opts) => {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    const force = Boolean(opts?.force);
    // 简单缓存：同一群 60s 内不重复拉取；force=true 允许绕过，但仍做 3s 防抖避免高频刷
    const now = Date.now();
    const last = get().loadedGroupAt[gid] ?? 0;
    if (!force && now - last < 60_000) return;
    if (force && now - last < 3000) return;

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

  resolveUser: (userId) => {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    return get().byId[uid] ?? null;
  },

  resolveRobotForViewRole: (viewRole) => {
    const vr = String(viewRole || '').trim().toUpperCase();
    if (vr !== 'PM' && vr !== 'DEV' && vr !== 'QA' && vr !== 'ADMIN') return null;

    const wantName = vr === 'QA' ? '测试' : vr === 'DEV' ? '开发' : vr === 'PM' ? '产品' : '管理员';
    const users = Object.values(get().byId || {});
    if (users.length === 0) return null;

    // 1) 强匹配：robot tag 且 tag.name 含期望中文名
    for (const u of users) {
      const tags = Array.isArray(u?.tags) ? u.tags : [];
      const hasRobot = tags.some((t) => String(t?.role || '').trim().toLowerCase() === 'robot');
      if (!hasRobot) continue;
      const hit = tags.some((t) => String(t?.name || '').trim().includes(wantName));
      if (hit) return u;
    }

    // 2) 兜底：任意 robot 成员（保证至少能显示机器人 tag/头像入口）
    for (const u of users) {
      const tags = Array.isArray(u?.tags) ? u.tags : [];
      const hasRobot = tags.some((t) => String(t?.role || '').trim().toLowerCase() === 'robot');
      if (hasRobot) return u;
    }

    return null;
  },
}));


