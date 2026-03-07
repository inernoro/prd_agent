import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';

// ─── Types ───

export interface HostedSiteFile {
  path: string;
  cosKey: string;
  size: number;
  mimeType: string;
}

export interface HostedSite {
  id: string;
  title: string;
  description?: string;
  sourceType: string;
  sourceRef?: string;
  cosPrefix: string;
  entryFile: string;
  siteUrl: string;
  files: HostedSiteFile[];
  totalSize: number;
  tags: string[];
  folder?: string;
  coverImageUrl?: string;
  ownerUserId: string;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShareLinkItem {
  id: string;
  token: string;
  siteId?: string;
  siteIds: string[];
  shareType: string;
  title?: string;
  description?: string;
  accessLevel: string;
  password?: string;
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

// ─── Helper ───

function getApiBaseUrl() {
  return ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

// ─── Upload (FormData) ───

export async function uploadSite(input: {
  file: File;
  title?: string;
  description?: string;
  folder?: string;
  tags?: string;
}): Promise<ApiResponse<HostedSite>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);
  if (input.title) fd.append('title', input.title);
  if (input.description) fd.append('description', input.description);
  if (input.folder) fd.append('folder', input.folder);
  if (input.tags) fd.append('tags', input.tags);

  const url = joinUrl(getApiBaseUrl(), api.webPages.upload());
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<HostedSite>;
  } catch {
    return { success: false, data: null as never, error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` } };
  }
}

export async function reuploadSite(id: string, file: File): Promise<ApiResponse<HostedSite>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);

  const url = joinUrl(getApiBaseUrl(), api.webPages.reupload(encodeURIComponent(id)));
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<HostedSite>;
  } catch {
    return { success: false, data: null as never, error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` } };
  }
}

// ─── From Content ───

export async function createFromContent(input: {
  htmlContent: string;
  title?: string;
  description?: string;
  sourceType?: string;
  sourceRef?: string;
  tags?: string[];
  folder?: string;
}): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.fromContent(), { method: 'POST', body: input });
}

// ─── CRUD ───

export async function listSites(params?: {
  keyword?: string;
  folder?: string;
  tag?: string;
  sourceType?: string;
  sort?: string;
  skip?: number;
  limit?: number;
}): Promise<ApiResponse<{ items: HostedSite[]; total: number }>> {
  const sp = new URLSearchParams();
  if (params?.keyword) sp.set('keyword', params.keyword);
  if (params?.folder) sp.set('folder', params.folder);
  if (params?.tag) sp.set('tag', params.tag);
  if (params?.sourceType) sp.set('sourceType', params.sourceType);
  if (params?.sort) sp.set('sort', params.sort);
  if (params?.skip) sp.set('skip', String(params.skip));
  if (params?.limit) sp.set('limit', String(params.limit));
  const q = sp.toString();
  return apiRequest(`${api.webPages.list()}${q ? `?${q}` : ''}`, { method: 'GET' });
}

export async function getSite(id: string): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.byId(encodeURIComponent(id)), { method: 'GET' });
}

export async function updateSite(id: string, data: {
  title?: string;
  description?: string;
  tags?: string[];
  folder?: string;
  coverImageUrl?: string;
}): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.byId(encodeURIComponent(id)), { method: 'PUT', body: data });
}

export async function deleteSite(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.webPages.byId(encodeURIComponent(id)), { method: 'DELETE' });
}

export async function batchDeleteSites(ids: string[]): Promise<ApiResponse<{ deletedCount: number }>> {
  return apiRequest(api.webPages.batchDelete(), { method: 'POST', body: { ids } });
}

export async function listFolders(): Promise<ApiResponse<{ folders: string[] }>> {
  return apiRequest(api.webPages.folders(), { method: 'GET' });
}

export async function listTags(): Promise<ApiResponse<{ tags: TagCount[] }>> {
  return apiRequest(api.webPages.tags(), { method: 'GET' });
}

// ─── Share ───

export async function createShareLink(data: {
  siteId?: string;
  siteIds?: string[];
  shareType?: string;
  title?: string;
  description?: string;
  password?: string;
  expiresInDays?: number;
}): Promise<ApiResponse<{ id: string; token: string; shareType: string; accessLevel: string; expiresAt?: string; shareUrl: string }>> {
  return apiRequest(api.webPages.share(), { method: 'POST', body: data });
}

export async function listShares(): Promise<ApiResponse<{ items: ShareLinkItem[] }>> {
  return apiRequest(api.webPages.shares(), { method: 'GET' });
}

export async function revokeShare(shareId: string): Promise<ApiResponse<{ revoked: boolean }>> {
  return apiRequest(api.webPages.revokeShare(encodeURIComponent(shareId)), { method: 'DELETE' });
}

// ─── Public Share View ───

export interface SharedSiteInfo {
  id: string;
  title: string;
  description?: string;
  siteUrl: string;
  entryFile: string;
  totalSize: number;
  fileCount: number;
  coverImageUrl?: string;
}

export interface ShareViewData {
  title: string;
  description?: string;
  shareType: string;
  createdAt: string;
  sites: SharedSiteInfo[];
}

export async function viewShare(token: string, password?: string): Promise<ApiResponse<ShareViewData>> {
  const q = password ? `?password=${encodeURIComponent(password)}` : '';
  // 使用 raw fetch 避免 apiRequest 的 401 自动 refresh/redirect 逻辑，此端点是公开的
  const url = joinUrl(getApiBaseUrl(), `${api.webPages.viewShare(encodeURIComponent(token))}${q}`);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const json = await res.json();
    return json as ApiResponse<ShareViewData>;
  } catch {
    return { success: false, data: null as never, error: { code: 'NETWORK_ERROR', message: '网络请求失败' } };
  }
}
