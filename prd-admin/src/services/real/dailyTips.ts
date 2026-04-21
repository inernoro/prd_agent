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
  /** 当前用户在该 tip 上的投递状态(pending/seen/clicked/dismissed),无投递记录时为 null */
  deliveryStatus?: string | null;
  deliveryViewCount?: number | null;
  deliveryMaxViews?: number | null;
}

export type TrackAction = 'seen' | 'clicked' | 'dismissed';

export interface DailyTipDelivery {
  userId: string;
  userDisplayName?: string | null;
  status: 'pending' | 'seen' | 'clicked' | 'dismissed';
  viewCount: number;
  maxViews: number;
  pushedAt: string;
  lastSeenAt?: string | null;
  clickedAt?: string | null;
  dismissedAt?: string | null;
}

export interface DailyTipStatsSummary {
  total: number;
  pending: number;
  seen: number;
  clicked: number;
  dismissed: number;
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

/** 推送 tip 给指定用户。reset=true 时重置已有记录为 pending。 */
export async function pushTip(
  id: string,
  body: { userIds: string[]; maxViews?: number; reset?: boolean },
): Promise<ApiResponse<{ pushedCount: number; totalDeliveries: number; deliveries: DailyTipDelivery[] }>> {
  return await apiRequest<{ pushedCount: number; totalDeliveries: number; deliveries: DailyTipDelivery[] }>(
    api.dailyTips.admin.push(id),
    { method: 'POST', body },
  );
}

/** 查看 tip 的推送统计(每用户状态 + 汇总)。 */
export async function getTipStats(
  id: string,
): Promise<ApiResponse<{ summary: DailyTipStatsSummary; items: DailyTipDelivery[] }>> {
  return await apiRequest<{ summary: DailyTipStatsSummary; items: DailyTipDelivery[] }>(
    api.dailyTips.admin.stats(id),
    { method: 'GET' },
  );
}

/** 记录当前用户对 tip 的交互动作:seen / clicked / dismissed。静默失败(不阻塞 UI)。 */
export async function trackTip(id: string, action: TrackAction): Promise<void> {
  try {
    await apiRequest<unknown>(api.dailyTips.track(id), {
      method: 'POST',
      body: { action },
    });
  } catch {
    /* tracking 失败不影响用户操作 */
  }
}
