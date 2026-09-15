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

  /** 人类盲测对战分（Elo 风格）。只有分数榜有，agent 榜为 null */
  score: number | null;
  /**
   * 分数置信区间的上/下半宽。
   *
   * 多数榜两边一样（页面写「±13」），code 榜写成「+16/-16」。存两个数是为了不把
   * 非对称区间压扁——真遇到 +20/-5 时压扁会让误差须画错方向。相等时前端渲染成「±13」。
   */
  scoreMarginUp: number | null;
  scoreMarginDown: number | null;
  /** 人类投票数（参与了多少次盲测对战） */
  votes: number | null;
  /** 上下文窗口，原样保留页面写法（如 "1M"）。图像视频榜没有这一列 */
  contextWindow: string | null;
  /** 榜单给这一行打了「初步」标：样本还不够，分数会继续变 */
  preliminary: boolean;

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
  /**
   * 表格形状：agent = 六指标那套，score = 对战分那套。
   *
   * 由后端按**页面实际解析出来的结构**写进快照，不是前端按榜名硬猜——
   * 对方哪天改了某个榜的结构，这里会跟着变。
   */
  kind?: 'agent' | 'score';
  /** 模型个数 */
  total?: number;
  /** 榜单口径下的会话总数（页面头部那个数）。抓不到时不显示这一格 */
  totalSessions?: number | null;
  /** 分数榜口径下的总投票数（页面头部那个数）。与 totalSessions 是两件事，不合并 */
  totalVotes?: number | null;
  entries: ModelLeaderboardEntry[];
}

/** 一个分榜的目录项，字段与后端 LeaderboardBoardInfo 一一对应。 */
export interface LeaderboardBoardInfo {
  key: string;
  /** 中文名。**后端给的**——前端不另存一份映射表（frontend-architecture.md 单一数据源） */
  label: string;
  /** 分组中文名，切换器按它分段 */
  group: string;
  kind: 'agent' | 'score';
  /** 一句话说明这个榜在比什么 */
  hint: string;
  /** 库里已经有这个榜的快照。false = 首次同步还没轮到它 */
  ready: boolean;
  total: number;
}

export interface LeaderboardCatalog {
  defaultBoard: string;
  boards: LeaderboardBoardInfo[];
}

/**
 * 读分榜目录：有哪些榜、叫什么、归哪组、是什么形状。
 *
 * 这份清单只能来自后端。前端曾经写死过一个「只有 agent 一个榜」的常量，
 * 而那个结论本身是错的（见后端 ModelLeaderboardCatalog 的注释），错误就这么被抄了两份。
 */
export function getLeaderboardBoards(): Promise<ApiResponse<LeaderboardCatalog>> {
  return apiRequest<LeaderboardCatalog>('/api/model-leaderboard/boards', { method: 'GET' });
}

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
 *
 * @param board 只同步这一个榜。不传则同步全部十一个，要跑一分钟左右——
 *   页面上的按钮一律传当前正在看的那个榜，点一次几秒就好。
 */
export function syncModelLeaderboard(
  board?: string,
): Promise<ApiResponse<ModelLeaderboardSyncResult>> {
  const query = board ? `?board=${encodeURIComponent(board)}` : '';
  return apiRequest<ModelLeaderboardSyncResult>(`/api/model-leaderboard/sync${query}`, {
    method: 'POST',
    // 榜单页是 0.5-3MB 的服务端渲染大页面；不传 board 时十一个榜串行抓，要跑一分钟往上。
    // 超时了也不代表同步失败，只是前端不等了。
    timeoutMs: 600_000,
  });
}
