import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

/** 短链目标系统类型 — 与后端 ShortLinkTargetTypes 对齐 */
export type ShortLinkTargetType =
  | 'web_page'
  | 'workflow'
  | 'defect'
  | 'report'
  | 'document_store'
  | 'toolbox'
  | (string & {});

export interface ShortLinkResolved {
  seq: number;
  targetType: ShortLinkTargetType;
  /** 各分享系统内的 Token，用于调用对应业务端点 */
  token: string;
  createdAt: string;
}

/** 按数字 Seq 解析短链，得到 (targetType, token) */
export async function resolveShortLink(seq: number | string): Promise<ApiResponse<ShortLinkResolved>> {
  return apiRequest(api.shortLinks.resolve(seq));
}

// ── 管理员：列表 / 吊销 / 修复 counter ────────────────────────────

export interface AdminShortLinkItem {
  seq: number;
  targetType: ShortLinkTargetType;
  token: string;
  createdAt: string;
  share: AdminShortLinkShareMeta | null;
}

export interface AdminShortLinkShareMeta {
  title?: string;
  shareType: string;
  accessLevel: string;
  viewCount: number;
  isRevoked: boolean;
  expiresAt?: string | null;
  createdBy: string;
  createdByName?: string;
  sharedAt: string;
}

export async function listAdminShortLinks(params?: {
  targetType?: string;
  search?: string;
  skip?: number;
  limit?: number;
}): Promise<ApiResponse<{ items: AdminShortLinkItem[]; total: number }>> {
  const sp = new URLSearchParams();
  if (params?.targetType) sp.set('targetType', params.targetType);
  if (params?.search) sp.set('search', params.search);
  if (params?.skip != null) sp.set('skip', String(params.skip));
  if (params?.limit != null) sp.set('limit', String(params.limit));
  const q = sp.toString();
  return apiRequest(`/api/admin/short-links${q ? `?${q}` : ''}`);
}

export async function revokeAdminShortLink(seq: number): Promise<ApiResponse<{ revoked: boolean }>> {
  return apiRequest(`/api/admin/short-links/${seq}/revoke`, { method: 'POST' });
}

export async function repairShortLinkCounter(): Promise<ApiResponse<{ repaired: boolean; counterSet: number }>> {
  return apiRequest('/api/admin/short-links/repair-counter', { method: 'POST' });
}
