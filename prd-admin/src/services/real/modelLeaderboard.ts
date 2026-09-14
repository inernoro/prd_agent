import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

/** 榜单里的一行（与后端 ModelLeaderboardController.Project 一一对应）。 */
export interface ModelLeaderboardEntry {
  rank: number;
  name: string;
  organization: string | null;
  license: string | null;
  /** 该榜的主分数。agent 榜是净改进百分比（13.85 表示 +13.85%）。 */
  score: number;
  /** 分数的 ± 误差范围，榜单没给时为 null。 */
  margin: number | null;
  previousRank: number | null;
  /**
   * 名次变化：正数表示上升几名，负数表示下降。
   *
   * **null 表示「不知道」**，不是「没变化」——首次同步时没有上一份快照可比。
   * 渲染时必须区分这两种：null 不画箭头，0 才画持平。
   */
  rankDelta: number | null;
}

/** 一个分榜的快照。 */
export interface ModelLeaderboardSnapshot {
  board: string;
  /** false = 后台首次同步还没跑完，前端给「正在准备」而不是画空表。 */
  ready: boolean;
  /** 数据抓取时刻（ISO 字符串）。页面上「数据截至」显示的就是它。 */
  fetchedAt?: string;
  sourceUrl?: string;
  /** 超过两天没同步成功。前端把实时点变灰并标出数据日期，不装作是新的。 */
  stale?: boolean;
  total?: number;
  entries: ModelLeaderboardEntry[];
}

/** 可选的分榜，与后端 ModelLeaderboardSyncWorker.Boards 对齐。 */
export const LEADERBOARD_BOARDS = [
  { key: 'agent', label: 'Agent', hint: '工具可靠性 / 任务完成 / 可操控性' },
  { key: 'code', label: '代码', hint: '代码能力对战' },
  { key: 'document', label: '文档', hint: '长文档理解' },
  { key: 'vision', label: '视觉', hint: '图像理解' },
  { key: 'text-to-image', label: '生图', hint: '文生图' },
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
