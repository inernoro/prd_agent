import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

/**
 * 一个指标：值 + 置信区间半宽。
 *
 * `value` 自带正负号（页面上的 ▲/▼ 后端已经解析进符号），所以 -0.91 就是「掉了 0.91%」，
 * 前端不需要再判方向。`margin` 为 null 表示榜单没给误差范围，画图时退化成一根实心条。
 */
export interface ModelMetric {
  value: number;
  margin: number | null;
}

/** 榜单里的一行（与后端 ModelLeaderboardController.Project 一一对应）。 */
export interface ModelLeaderboardEntry {
  rank: number;
  /**
   * 名次的置信区间。两个模型区间重叠时名次差别不作数——页面把区间显示出来才诚实。
   * 抓不到时为 null，前端不显示这一行小字。
   */
  rankLow: number | null;
  rankHigh: number | null;
  name: string;
  organization: string | null;
  license: string | null;

  /** 主排序指标 */
  netImprovement: ModelMetric | null;
  confirmedSuccess: ModelMetric | null;
  praiseVsComplaint: ModelMetric | null;
  steerability: ModelMetric | null;
  bashRecovery: ModelMetric | null;
  /** 工具幻觉——这项越低越好 */
  toolHallucination: ModelMetric | null;

  sessions: number | null;
  /** 单任务成本中位数，美元 */
  costPerTask: number | null;
  /** 单任务输出 token 中位数，原样保留页面写法（如 "55.2K"） */
  outputTokens: string | null;
  priceInput: number | null;
  priceOutput: number | null;

  previousRank: number | null;
  /**
   * 名次变化：正数上升，负数下降。
   *
   * **null 表示「不知道」**，不是「没变化」——首次同步时没有上一份快照可比。
   * 渲染时必须区分：null 不画箭头，0 才画持平。
   */
  rankDelta: number | null;
}

/** 一个分榜的快照。 */
export interface ModelLeaderboardSnapshot {
  board: string;
  /** false = 后台首次同步还没跑完，前端给「正在准备」而不是画空表。 */
  ready: boolean;
  fetchedAt?: string;
  sourceUrl?: string;
  /** 超过两天没同步成功。前端把实时点变灰并标出数据日期，不装作是新的。 */
  stale?: boolean;
  /** 模型个数 */
  total?: number;
  /** 榜单口径下的会话总数（页面头部那个数）。抓不到时不显示这一格 */
  totalSessions?: number | null;
  entries: ModelLeaderboardEntry[];
}

/**
 * 可选的分榜，与后端 ModelLeaderboardSyncWorker.Boards 对齐。
 *
 * 目前只有 Agent 一个：arena.ai 站内虽有 code / vision 等分榜，但只有 agent 榜的排名是
 * 服务端渲染的，其余要浏览器执行 JS 才异步加载（详见后端 Boards 的注释）。
 * 只有一个选项时页面不显示切换 tab——没得选就别摆一个假的选择器。
 */
export const LEADERBOARD_BOARDS = [
  { key: 'agent', label: 'Agent', hint: '工具可靠性 / 任务完成 / 可操控性' },
] as const;

export type LeaderboardBoardKey = (typeof LEADERBOARD_BOARDS)[number]['key'];

/** 读一个分榜的完整快照（榜单页用）。 */
export function getModelLeaderboard(
  board: string = 'agent',
  limit = 50,
): Promise<ApiResponse<ModelLeaderboardSnapshot>> {
  return apiRequest<ModelLeaderboardSnapshot>(
    `/api/model-leaderboard?board=${encodeURIComponent(board)}&limit=${limit}`,
    { method: 'GET' },
  );
}

/**
 * 只取前几名（首页挂件用）。
 *
 * 单独一个端点是因为首页每次加载都会打它，没必要为了显示三行就把整个榜传回来。
 */
export function getModelLeaderboardTop(
  board: string = 'agent',
  limit = 3,
): Promise<ApiResponse<ModelLeaderboardSnapshot>> {
  return apiRequest<ModelLeaderboardSnapshot>(
    `/api/model-leaderboard/top?board=${encodeURIComponent(board)}&limit=${limit}`,
    { method: 'GET' },
  );
}

/** 手动同步的结果回显。 */
export interface ModelLeaderboardSyncResult {
  total: number;
  succeeded: number;
  boards: Array<{ board: string; ok: boolean; count: number; error: string | null }>;
}

/**
 * 手动触发一次榜单同步（需「模型管理-写」权限）。
 *
 * 周期同步只在权威部署跑，所以分支预览上的库是空的；要在预览环境看效果就得手动点一次。
 * 会真的去打 arena.ai，别当刷新按钮用。
 */
export function syncModelLeaderboard(): Promise<ApiResponse<ModelLeaderboardSyncResult>> {
  return apiRequest<ModelLeaderboardSyncResult>('/api/model-leaderboard/sync', {
    method: 'POST',
    // 榜单页是 1.8MB 的服务端渲染大页面，默认超时不够
    timeoutMs: 180_000,
  });
}
