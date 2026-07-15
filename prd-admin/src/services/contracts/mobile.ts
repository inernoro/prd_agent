import type { ApiResponse } from '@/types/api';

// ─── Feed ───

export interface FeedItem {
  id: string;
  type: 'prd-session' | 'visual-workspace' | 'defect';
  title: string;
  subtitle: string;
  updatedAt: string;
  navigateTo: string;
  coverAssetId?: string;
}

export type GetMobileFeedContract = (args?: {
  limit?: number;
}) => Promise<ApiResponse<{ items: FeedItem[] }>>;

// ─── Stats ───

/** 单日统计桶（按用户本地时区切日,旧→新） */
export interface MobileStatsDay {
  /** yyyy-MM-dd（用户本地时区） */
  date: string;
  /** PRD 解读会话/消息(桌面时代口径,保留兼容;前端展示已换 aiCalls/defects) */
  sessions: number;
  messages: number;
  imageGenerations: number;
  /** LLM 请求次数(AI 调用) */
  aiCalls?: number;
  /** 缺陷提报数 */
  defects?: number;
  tokens: number;
}

export interface MobileStats {
  days: number;
  /** PRD 解读会话/消息(桌面时代口径,保留兼容;前端展示已换 aiCalls/defects) */
  sessions: number;
  messages: number;
  imageGenerations: number;
  /** LLM 请求次数(AI 调用) */
  aiCalls?: number;
  /** 缺陷提报数 */
  defects?: number;
  totalTokens: number;
  /** 按日序列（供首页迷你趋势柱）;旧后端无此字段,消费端需容错 */
  daily?: MobileStatsDay[];
}

export type GetMobileStatsContract = (args?: {
  days?: number;
}) => Promise<ApiResponse<MobileStats>>;

// ─── Assets ───

export interface MobileAssetItem {
  id: string;
  type: 'image' | 'document' | 'attachment' | 'webpage';
  title: string;
  /** 内容摘要（前80字） */
  summary?: string | null;
  /** 来源标签（如"视觉创作"、"PRD Agent"、"手动上传"） */
  source?: string | null;
  url?: string | null;
  thumbnailUrl?: string;
  mime?: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: string;
  workspaceId?: string;
}

export interface MobileAssetsResponse {
  items: MobileAssetItem[];
  total: number;
  hasMore: boolean;
  /** 各分类精确计数（始终基于全量数据，不受 category 过滤影响） */
  categoryCounts: Record<string, number>;
  /** 全部资产总存储字节数 */
  totalSizeBytes: number;
  /** 来源分布（如 { "视觉创作": 30, "手动上传": 19, "PRD Agent": 3 }） */
  sourceCounts: Record<string, number>;
  /** 最近活动时间 */
  latestActivity?: string | null;
}

export type GetMobileAssetsContract = (args?: {
  category?: 'image' | 'document' | 'attachment' | 'webpage';
  limit?: number;
  skip?: number;
}) => Promise<ApiResponse<MobileAssetsResponse>>;
