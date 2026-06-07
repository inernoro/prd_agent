import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ============ Types（对齐后端 DailyTipsController） ============
// 注:「小技巧管理」后台(create/update/delete/push/seed/reset)已于 2026-06-04 整体下线,
// 教程统一为代码内置 seed(BuildDefaultTips)。本文件只保留运行时(用户侧)读取与交互所需的导出。

export type DailyTipKind = 'text' | 'card' | 'spotlight';

/** 教程难度:初(beginner) / 中(intermediate) / 高(advanced)。决定完成后获得的经验值权重。 */
export type TutorialDifficulty = 'beginner' | 'intermediate' | 'advanced';

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
  /** 该 *-page-guide 是否已被当前用户「学会」。学会后仍返回(供重看),前端据此停止自动开讲 + 入口脉冲。 */
  learned?: boolean;
  createdAt?: string;
  /** 当前用户在该 tip 上的投递状态(pending/seen/clicked/dismissed),无投递记录时为 null */
  deliveryStatus?: string | null;
  deliveryViewCount?: number | null;
  deliveryMaxViews?: number | null;
  /** 难度分级:初/中/高(后端下发,缺省 beginner)。 */
  difficulty?: TutorialDifficulty;
  /** 完成该教程可获得的经验值(后端按 difficulty 计算)。 */
  xpReward?: number;
}

export type TrackAction = 'seen' | 'clicked' | 'dismissed';

/** 官方教程分类:onboarding(本页教程,计入掌握度) / update(本周更新) / task(快捷任务) */
export type TutorialCategory = 'onboarding' | 'update' | 'task';

/** 单条官方教程的进度条目(来自 GET /api/daily-tips/progress) */
export interface TutorialProgressItem {
  sourceId: string;
  /** visible 端点里这条 seed 的 id(seed-{sourceId}),供学习中心直接开讲 */
  tipId: string;
  title: string;
  body?: string | null;
  actionUrl: string;
  ctaText?: string | null;
  targetSelector?: string | null;
  autoAction?: DailyTipAutoAction | null;
  steps: number;
  category: TutorialCategory;
  version: number;
  learned: boolean;
  /** 难度:初/中/高。 */
  difficulty: TutorialDifficulty;
  /** 完成该教程可获得的经验值。 */
  xpReward: number;
}

export interface TutorialProgress {
  /** 计入掌握度的本页教程(onboarding)总数 */
  total: number;
  /** 已学会的本页教程数 */
  learned: number;
  /** 累计经验值(所有已完成教程的 xpReward 之和,完成越多越高) */
  xp: number;
  /** 当前等级(后端按 xp 阈值计算,从 1 起) */
  level: number;
  /** 当前等级名(新手 / 进阶 / 高手 / 大师 / 宗师) */
  levelName: string;
  /** 升到下一级还需的经验值;已满级为 0 */
  xpToNext: number;
  /** 当前等级区间起点经验(用于画等级内进度条) */
  levelFloorXp: number;
  /** 下一级所需经验阈值(满级时等于 levelFloorXp) */
  nextLevelXp: number;
  /** 全部官方教程(含 task / update) */
  items: TutorialProgressItem[];
}

// ============ 公共读取 ============

export async function listVisibleTips(): Promise<ApiResponse<{ items: DailyTip[] }>> {
  return await apiRequest<{ items: DailyTip[] }>(api.dailyTips.visible(), { method: 'GET' });
}

/** 当前用户对全部官方教程的学习进度 + 经验/等级(头像进度环 + 学习中心页消费)。 */
export async function getTutorialProgress(): Promise<ApiResponse<TutorialProgress>> {
  return await apiRequest<TutorialProgress>(api.dailyTips.progress(), { method: 'GET' });
}

// ============ 用户交互 ============

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
 * 之后掌握度 +1、累计经验 +xpReward;Tour 走完最后一步 / 用户主动点「✓ 我已学会」时调用。
 */
export async function markTipAsLearned(
  id: string,
): Promise<ApiResponse<{ learned: { sourceId: string; version: number } }>> {
  return await apiRequest<{ learned: { sourceId: string; version: number } }>(
    api.dailyTips.markLearned(id),
    { method: 'POST', body: {} },
  );
}
