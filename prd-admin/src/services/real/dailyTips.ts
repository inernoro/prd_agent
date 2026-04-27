import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ============ Types（对齐后端 DailyTipsController / AdminDailyTipsController） ============

export type DailyTipKind = 'text' | 'card' | 'spotlight';

/** Tip 落地页后的自动引导动作(由 SpotlightOverlay 按序执行)。 */
export interface DailyTipAutoAction {
  /** 滚动模式:center / top / none。空=center */
  scroll?: 'center' | 'top' | 'none' | null;
  /** 需要先展开的折叠面板 selector(点击一次触发 React state)。 */
  expand?: string | null;
  /** 预填充输入框 */
  prefill?: { selector: string; value: string } | null;
  /** 延迟后自动点击的 selector(如 CTA 按钮)。 */
  autoClick?: string | null;
  /** autoClick 之前的延迟,毫秒。默认 1200。 */
  autoClickDelayMs?: number | null;
  /** 多步 Tour:有多少 step 就画多少圈,用户点"下一步"
   *  navigateTo 非空时,切到这一步时先 navigate 过去再 poll selector(跨页 Tour) */
  steps?: Array<{
    selector: string;
    title: string;
    body?: string | null;
    navigateTo?: string | null;
  }> | null;
}

export interface DailyTip {
  id: string;
  kind: DailyTipKind;
  title: string;
  body?: string | null;
  coverImageUrl?: string | null;
  actionUrl: string;
  ctaText?: string | null;
  targetSelector?: string | null;
  autoAction?: DailyTipAutoAction | null;
  isTargeted?: boolean;
  sourceType?: string | null;
  /** 来源 ID(seed 标识或自定义业务键),用于版本控制 + dismiss/learn 跨重建匹配 */
  sourceId?: string | null;
  /** 内容版本号(默认 1)。管理员升级 tip 时 +1,旧的"已学会"用户会重新看到 */
  version?: number;
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
  autoAction?: DailyTipAutoAction | null;
  targetUserId?: string | null;
  targetRoles?: string[] | null;
  displayOrder?: number;
  isActive?: boolean;
  startAt?: string | null;
  endAt?: string | null;
  /** 场景分类:feature-release / tip / bug-fix / onboarding / manual(默认) */
  sourceType?: string | null;
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

/** 推送 tip 给指定用户 / 按角色 / 全体。reset=true 时重置已有记录为 pending。
 *  scope: "all" / "role:PM" / "role:DEV" / "role:QA" / "role:ADMIN",与 userIds 取并集。 */
export async function pushTip(
  id: string,
  body: { userIds?: string[]; scope?: string; maxViews?: number; reset?: boolean },
): Promise<ApiResponse<{ pushedCount: number; totalDeliveries: number; deliveries: DailyTipDelivery[] }>> {
  return await apiRequest<{ pushedCount: number; totalDeliveries: number; deliveries: DailyTipDelivery[] }>(
    api.dailyTips.admin.push(id),
    { method: 'POST', body },
  );
}

/**
 * 一键植入内置默认 tip。幂等:按 SourceId 判重,已存在的不动。
 * 同时清理已废弃的 seed(如旧的 showcase-all-features)。
 * 用于新环境或清空后让管理员一次性把 seed 变成真实数据,之后可再编辑。
 */
export async function seedDefaultTips(): Promise<
  ApiResponse<{ insertedCount: number; skippedCount: number; totalDefaults: number }>
> {
  return await apiRequest<{ insertedCount: number; skippedCount: number; totalDefaults: number }>(
    api.dailyTips.admin.seed(),
    { method: 'POST', body: {} },
  );
}

/** 清空所有 DailyTip 并重新植入 seed。危险操作,调用方应先二次确认。 */
export async function resetDefaultTips(): Promise<
  ApiResponse<{ deletedCount: number; insertedCount: number }>
> {
  return await apiRequest<{ deletedCount: number; insertedCount: number }>(
    api.dailyTips.admin.reset(),
    { method: 'POST', body: {} },
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

/** 永久关闭某条 tip:把 id 追加到 User.DismissedTipIds,/visible 端点以后都不再返回。 */
export async function dismissTipForever(
  id: string,
): Promise<ApiResponse<{ dismissedForever: string }>> {
  return await apiRequest<{ dismissedForever: string }>(
    api.dailyTips.dismissForever(id),
    { method: 'POST', body: {} },
  );
}

/**
 * 标记某条 tip 为「已学会」。把 (SourceId, Version) 写入 User.LearnedTips,
 * 之后 /visible 端点过滤时不再返回;管理员升级 tip.Version 后会重新出现。
 * Tour 走完最后一步 / 用户主动点「✓ 我已学会」时调用。
 */
export async function markTipAsLearned(
  id: string,
): Promise<ApiResponse<{ learned: { sourceId: string; version: number } }>> {
  return await apiRequest<{ learned: { sourceId: string; version: number } }>(
    api.dailyTips.markLearned(id),
    { method: 'POST', body: {} },
  );
}
