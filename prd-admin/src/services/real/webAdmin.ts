import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ─── Types（与后端 AdminWebPagesController 返回结构镜像）───

export interface AdminSite {
  id: string;
  title: string;
  description?: string;
  ownerUserId: string;
  viewCount: number;
  visibility: string;
  sourceType?: string;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  folder?: string;
}

export interface AdminOwner {
  userId: string;
  displayName: string;
  avatarFileName?: string;
}

export interface AdminSiteViewer {
  id?: string;
  siteId?: string;
  siteTitle?: string;
  viewerUserId?: string;
  viewerName?: string;
  viewerAvatarFileName?: string;
  viewedAt: string;
  ipAddress?: string;
  userAgent?: string;
}

// ─── 全部站点列表（跨所有用户）───

export async function listAllSites(params?: {
  keyword?: string;
  ownerUserId?: string;
  sort?: string;
  skip?: number;
  limit?: number;
}): Promise<ApiResponse<{ items: AdminSite[]; total: number; owners: Record<string, AdminOwner> }>> {
  const sp = new URLSearchParams();
  if (params?.keyword) sp.set('keyword', params.keyword);
  if (params?.ownerUserId) sp.set('ownerUserId', params.ownerUserId);
  if (params?.sort) sp.set('sort', params.sort);
  if (params?.skip != null) sp.set('skip', String(params.skip));
  if (params?.limit != null) sp.set('limit', String(params.limit));
  const q = sp.toString();
  return apiRequest(`${api.adminWebPages.list()}${q ? `?${q}` : ''}`, { method: 'GET' });
}

// ─── 单站点访客记录 ───

export async function listSiteViewersAdmin(
  id: string,
  skip = 0,
  limit = 50,
): Promise<ApiResponse<{ items: AdminSiteViewer[]; total: number; uniqueViewers: number }>> {
  const sp = new URLSearchParams();
  sp.set('skip', String(skip));
  sp.set('limit', String(limit));
  return apiRequest(`${api.adminWebPages.viewers(encodeURIComponent(id))}?${sp.toString()}`, {
    method: 'GET',
  });
}
