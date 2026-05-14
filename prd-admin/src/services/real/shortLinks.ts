import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
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

function getApiBaseUrl() {
  return ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

/**
 * 按数字 Seq 解析短链，得到 (targetType, token)。
 *
 * 走 raw fetch（不经 apiRequest）— 因为短链解析是公开端点 [AllowAnonymous]，
 * 接收方可能未登录。apiRequest 默认 auth=true，未登录时会在客户端直接返回
 * UNAUTHORIZED，外部用户的 /s/{seq} 永远打不开。
 * 同 viewShare 的模式：有 token 就带 Authorization 以便后端识别身份，无 token 也发请求。
 */
export async function resolveShortLink(seq: number | string): Promise<ApiResponse<ShortLinkResolved>> {
  const url = joinUrl(getApiBaseUrl(), api.shortLinks.resolve(seq));
  const headers: Record<string, string> = { Accept: 'application/json' };
  const authToken = useAuthStore.getState().token;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const res = await fetch(url, { headers });
    return (await res.json()) as ApiResponse<ShortLinkResolved>;
  } catch {
    return {
      success: false,
      data: null as never,
      error: { code: 'NETWORK_ERROR', message: '网络请求失败' },
    };
  }
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
