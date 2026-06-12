import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ─── Types（与后端 Team.cs 镜像；enum 走字符串联合，对应 enum-ripple 规则）───

export type TeamRole = 'admin' | 'member';
export type TeamVisibility = 'private' | 'public';
/** 网页托管内容角色（仅网页托管消费，知识库不读）。与后端 WebHostingRoles 镜像。 */
export type WebHostingRole = 'owner' | 'editor' | 'viewer';

export interface Team {
  id: string;
  name: string;
  description?: string;
  ownerUserId: string;
  ownerName?: string;
  visibility: TeamVisibility;
  inviteCode: string;
  inviteExpireAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  userName?: string;
  avatarFileName?: string;
  role: TeamRole;
  /** 网页托管角色覆盖；null/缺省 = 继承团队角色（admin→owner / member→editor） */
  webHostingRole?: WebHostingRole | null;
  /** 角色标签（如「前端组」「测试组」）：仅作授权分组用，本身不产生权限 */
  labels?: string[];
  joinedAt: string;
}

export interface TeamListItem {
  team: Team;
  myRole: TeamRole;
  memberCount: number;
}

export interface TeamActivityItem {
  id: string;
  teamId: string;
  appKey: string;
  actorUserId: string;
  actorName: string;
  actorAvatarFileName?: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetTitle?: string;
  createdAt: string;
}

export interface UserCard {
  userId: string;
  displayName: string;
  username?: string;
  avatarFileName?: string;
}

// ─── 团队 CRUD ───

export async function listMyTeams(): Promise<ApiResponse<{ items: TeamListItem[] }>> {
  return apiRequest(api.teams.list(), { method: 'GET' });
}

export async function createTeam(input: {
  name: string;
  description?: string;
  visibility?: TeamVisibility;
}): Promise<ApiResponse<{ team: Team; myRole: TeamRole; memberCount: number }>> {
  return apiRequest(api.teams.create(), { method: 'POST', body: input });
}

export async function getTeam(id: string): Promise<
  ApiResponse<{
    team: Team;
    members: TeamMember[];
    myRole: TeamRole;
    /** 各成员的网页托管有效角色（已解析继承）：userId → owner/editor/viewer */
    webHostingRoles: Record<string, WebHostingRole>;
    myWebHostingRole: WebHostingRole;
  }>
> {
  return apiRequest(api.teams.detail(encodeURIComponent(id)), { method: 'GET' });
}

export async function updateTeam(
  id: string,
  input: { name?: string; description?: string; visibility?: TeamVisibility },
): Promise<ApiResponse<Team>> {
  return apiRequest(api.teams.detail(encodeURIComponent(id)), { method: 'PUT', body: input });
}

export async function deleteTeam(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.teams.detail(encodeURIComponent(id)), { method: 'DELETE' });
}

// ─── 成员 ───

export async function addTeamMembers(
  id: string,
  userIds: string[],
): Promise<ApiResponse<{ added: number; members?: TeamMember[] }>> {
  return apiRequest(api.teams.members(encodeURIComponent(id)), { method: 'POST', body: { userIds } });
}

export async function removeTeamMember(
  id: string,
  userId: string,
): Promise<ApiResponse<{ removed: boolean }>> {
  return apiRequest(api.teams.member(encodeURIComponent(id), encodeURIComponent(userId)), {
    method: 'DELETE',
  });
}

export async function updateTeamMemberRole(
  id: string,
  userId: string,
  role: TeamRole,
): Promise<ApiResponse<{ updated: boolean; role: TeamRole }>> {
  return apiRequest(api.teams.member(encodeURIComponent(id), encodeURIComponent(userId)), {
    method: 'PUT',
    body: { role },
  });
}

/** 设置成员网页托管角色（owner/editor/viewer）。仅团队管理员可调；role=null 重置为继承。 */
export async function updateMemberWebHostingRole(
  id: string,
  userId: string,
  role: WebHostingRole | null,
): Promise<ApiResponse<{ updated: boolean; webHostingRole: WebHostingRole | null; effectiveWebHostingRole: WebHostingRole }>> {
  return apiRequest(api.teams.memberWebHostingRole(encodeURIComponent(id), encodeURIComponent(userId)), {
    method: 'PUT',
    body: { role },
  });
}

/** 设置成员角色标签（全量覆盖，空数组 = 清空）。仅团队管理员可调。 */
export async function updateMemberLabels(
  id: string,
  userId: string,
  labels: string[],
): Promise<ApiResponse<{ updated: boolean; labels: string[] }>> {
  return apiRequest(api.teams.memberLabels(encodeURIComponent(id), encodeURIComponent(userId)), {
    method: 'PUT',
    body: { labels },
  });
}

// ─── 邀请 ───

export async function regenerateInviteCode(
  id: string,
  expiresInDays?: number,
): Promise<ApiResponse<{ inviteCode: string; inviteExpireAt?: string | null }>> {
  return apiRequest(api.teams.inviteCode(encodeURIComponent(id)), {
    method: 'POST',
    body: { expiresInDays },
  });
}

export async function joinTeam(
  inviteCode: string,
): Promise<ApiResponse<{ joined: boolean; teamId: string; teamName?: string; alreadyMember?: boolean }>> {
  return apiRequest(api.teams.join(), { method: 'POST', body: { inviteCode } });
}

// ─── 活动日志 ───

export async function listTeamActivity(
  id: string,
  opts?: { app?: string; limit?: number },
): Promise<ApiResponse<{ items: TeamActivityItem[] }>> {
  const sp = new URLSearchParams();
  if (opts?.app) sp.set('app', opts.app);
  if (opts?.limit) sp.set('limit', String(opts.limit));
  const q = sp.toString();
  return apiRequest(`${api.teams.activity(encodeURIComponent(id))}${q ? `?${q}` : ''}`, {
    method: 'GET',
  });
}

// ─── 用户检索 / 解析 ───

export async function searchTeamUsers(
  q: string,
  limit = 20,
): Promise<ApiResponse<{ items: UserCard[] }>> {
  const sp = new URLSearchParams();
  if (q) sp.set('q', q);
  sp.set('limit', String(limit));
  return apiRequest(`${api.teams.searchUsers()}?${sp.toString()}`, { method: 'GET' });
}

export async function getUserCards(userIds: string[]): Promise<ApiResponse<{ items: UserCard[] }>> {
  const ids = userIds.filter(Boolean).join(',');
  return apiRequest(`${api.teams.userCards()}?ids=${encodeURIComponent(ids)}`, { method: 'GET' });
}

// ─── 把内容分享到团队 ───

export async function setSiteTeams(siteId: string, teamIds: string[]): Promise<ApiResponse<unknown>> {
  return apiRequest(api.webPages.setTeams(encodeURIComponent(siteId)), {
    method: 'PATCH',
    body: { teamIds },
  });
}

export async function setStoreTeams(storeId: string, teamIds: string[]): Promise<ApiResponse<unknown>> {
  return apiRequest(api.documentStore.stores.setTeams(encodeURIComponent(storeId)), {
    method: 'PATCH',
    body: { teamIds },
  });
}
