import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ─── Types ───

export interface WebPageItem {
  id: string;
  url: string;
  title: string;
  description?: string;
  faviconUrl?: string;
  coverImageUrl?: string;
  tags: string[];
  folder?: string;
  note?: string;
  isFavorite: boolean;
  isPublic: boolean;
  ownerUserId: string;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebPageShareLinkItem {
  id: string;
  token: string;
  webPageId?: string;
  webPageIds: string[];
  shareType: string;
  title?: string;
  description?: string;
  accessLevel: string;
  viewCount: number;
  lastViewedAt?: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  isRevoked: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}

// ─── API Functions ───

export async function listWebPages(params?: {
  keyword?: string;
  folder?: string;
  tag?: string;
  isFavorite?: boolean;
  sort?: string;
  skip?: number;
  limit?: number;
}): Promise<ApiResponse<{ items: WebPageItem[]; total: number }>> {
  const qs = new URLSearchParams();
  if (params?.keyword) qs.set('keyword', params.keyword);
  if (params?.folder) qs.set('folder', params.folder);
  if (params?.tag) qs.set('tag', params.tag);
  if (params?.isFavorite) qs.set('isFavorite', 'true');
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.skip) qs.set('skip', String(params.skip));
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return apiRequest(`${api.webPages.list()}${q ? `?${q}` : ''}`, { method: 'GET' });
}

export async function getWebPage(id: string): Promise<ApiResponse<WebPageItem>> {
  return apiRequest(api.webPages.byId(id), { method: 'GET' });
}

export async function createWebPage(data: {
  url: string;
  title: string;
  description?: string;
  faviconUrl?: string;
  coverImageUrl?: string;
  tags?: string[];
  folder?: string;
  note?: string;
  isFavorite?: boolean;
  isPublic?: boolean;
}): Promise<ApiResponse<WebPageItem>> {
  return apiRequest(api.webPages.list(), { method: 'POST', body: data });
}

export async function updateWebPage(id: string, data: {
  url?: string;
  title?: string;
  description?: string;
  faviconUrl?: string;
  coverImageUrl?: string;
  tags?: string[];
  folder?: string;
  note?: string;
  isFavorite?: boolean;
  isPublic?: boolean;
}): Promise<ApiResponse<WebPageItem>> {
  return apiRequest(api.webPages.byId(id), { method: 'PUT', body: data });
}

export async function deleteWebPage(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.webPages.byId(id), { method: 'DELETE' });
}

export async function batchDeleteWebPages(ids: string[]): Promise<ApiResponse<{ deletedCount: number }>> {
  return apiRequest(api.webPages.batchDelete(), { method: 'POST', body: { ids } });
}

export async function toggleWebPageFavorite(id: string): Promise<ApiResponse<{ isFavorite: boolean }>> {
  return apiRequest(api.webPages.toggleFavorite(id), { method: 'POST', body: '{}' });
}

export async function listWebPageFolders(): Promise<ApiResponse<{ folders: string[] }>> {
  return apiRequest(api.webPages.folders(), { method: 'GET' });
}

export async function listWebPageTags(): Promise<ApiResponse<{ tags: TagCount[] }>> {
  return apiRequest(api.webPages.tags(), { method: 'GET' });
}

export async function createWebPageShare(data: {
  webPageId?: string;
  webPageIds?: string[];
  shareType?: string;
  title?: string;
  description?: string;
  password?: string;
  expiresInDays?: number;
}): Promise<ApiResponse<{ id: string; token: string; shareType: string; accessLevel: string; expiresAt?: string; shareUrl: string }>> {
  return apiRequest(api.webPages.share(), { method: 'POST', body: data });
}

export async function listWebPageShares(): Promise<ApiResponse<{ items: WebPageShareLinkItem[] }>> {
  return apiRequest(api.webPages.shares(), { method: 'GET' });
}

export async function revokeWebPageShare(shareId: string): Promise<ApiResponse<{ revoked: boolean }>> {
  return apiRequest(api.webPages.revokeShare(shareId), { method: 'DELETE' });
}
