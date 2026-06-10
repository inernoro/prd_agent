import { apiRequest } from '@/services/real/apiClient';

/** 轻量用户检索结果（仅登录可用，不依赖 users.read 管理员权限） */
export interface DirectoryUser {
  userId: string;
  displayName: string;
  username: string;
  avatarFileName?: string | null;
}

/**
 * 按昵称/用户名搜索 MAP 用户（走 `/api/teams/search-users`，仅需登录）。
 * 用于选择处理人/干系人等场景——普通成员也能搜，不再误用管理员的 `/api/users` 列表。
 */
export function searchDirectoryUsers(q?: string, limit = 50) {
  const qs = new URLSearchParams();
  if (q && q.trim()) qs.set('q', q.trim());
  qs.set('limit', String(limit));
  return apiRequest<{ items: DirectoryUser[] }>(`/api/teams/search-users?${qs.toString()}`, { method: 'GET' });
}
