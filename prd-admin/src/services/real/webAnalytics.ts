import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ─── Types（与后端 SiteViewerItem / SiteViewersResult 镜像）───

export interface SiteViewer {
  viewerUserId: string;
  viewerName?: string;
  viewerAvatarFileName?: string;
  viewedAt: string;
}

export interface SiteViewersResult {
  items: SiteViewer[];
  total: number;
  uniqueViewers: number;
}

// ─── 埋点：记录一次站点访问 ───

export async function recordSiteView(id: string): Promise<ApiResponse<{ recorded: boolean }>> {
  return apiRequest(api.webPages.recordView(encodeURIComponent(id)), { method: 'POST' });
}

// ─── 访客列表（owner / 共享团队成员可见）───

export async function listSiteViewers(
  id: string,
  skip = 0,
  limit = 100,
): Promise<ApiResponse<SiteViewersResult>> {
  const sp = new URLSearchParams();
  sp.set('skip', String(skip));
  sp.set('limit', String(limit));
  return apiRequest(`${api.webPages.viewers(encodeURIComponent(id))}?${sp.toString()}`, {
    method: 'GET',
  });
}
