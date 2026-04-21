import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ============ Types（对齐后端 DailyTipsController / AdminDailyTipsController） ============

export type DailyTipKind = 'text' | 'card' | 'spotlight';

export interface DailyTip {
  id: string;
  kind: DailyTipKind;
  title: string;
  body?: string | null;
  coverImageUrl?: string | null;
  actionUrl: string;
  ctaText?: string | null;
  targetSelector?: string | null;
  isTargeted?: boolean;
  sourceType?: string | null;
  createdAt?: string;
}

export interface DailyTipAdmin extends DailyTip {
  targetUserId?: string | null;
  targetRoles?: string[] | null;
  displayOrder: number;
  isActive: boolean;
  startAt?: string | null;
  endAt?: string | null;
  sourceId?: string | null;
  createdBy?: string;
  updatedAt?: string;
}

export interface DailyTipUpsert {
  kind: DailyTipKind;
  title: string;
  body?: string | null;
  coverImageUrl?: string | null;
  actionUrl: string;
  ctaText?: string | null;
  targetSelector?: string | null;
  targetUserId?: string | null;
  targetRoles?: string[] | null;
  displayOrder?: number;
  isActive?: boolean;
  startAt?: string | null;
  endAt?: string | null;
}

// ============ 公共读取 ============

export async function listVisibleTips(): Promise<ApiResponse<{ items: DailyTip[] }>> {
  return await apiRequest<{ items: DailyTip[] }>(api.dailyTips.visible(), { method: 'GET' });
}

// ============ 管理后台 ============

export async function listTipsAdmin(): Promise<ApiResponse<{ items: DailyTipAdmin[] }>> {
  return await apiRequest<{ items: DailyTipAdmin[] }>(api.dailyTips.admin.list(), { method: 'GET' });
}

export async function createTip(
  body: DailyTipUpsert,
): Promise<ApiResponse<{ item: DailyTipAdmin }>> {
  return await apiRequest<{ item: DailyTipAdmin }>(api.dailyTips.admin.create(), {
    method: 'POST',
    body,
  });
}

export async function updateTip(
  id: string,
  body: DailyTipUpsert,
): Promise<ApiResponse<{ item: DailyTipAdmin }>> {
  return await apiRequest<{ item: DailyTipAdmin }>(api.dailyTips.admin.update(id), {
    method: 'PUT',
    body,
  });
}

export async function deleteTip(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return await apiRequest<{ deleted: boolean }>(api.dailyTips.admin.delete(id), {
    method: 'DELETE',
  });
}
