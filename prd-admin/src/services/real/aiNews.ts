import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

/** 首页「AI 大事早知道」单条资讯（与后端 AiNewsItem 一一对应，camelCase）。 */
export interface AiNewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  siteName: string;
  publishedAt: string | null;
  firstSeenAt: string | null;
  aiLabel: string;
  aiScore: number;
  /** 命中的 AI 关键信号词（如 ["智能体","RAG"]），作为附加标签展示。 */
  aiSignals: string[];
  /** 文章摘要片段（默认展示的「部分内容」，抓不到为 null）。 */
  excerpt?: string | null;
}

/** 资讯流响应（与后端 AiNewsFeed 对应）。 */
export interface AiNewsFeed {
  items: AiNewsItem[];
  total: number;
  generatedAt: string | null;
  /** 上游不可达且无缓存：前端走空态。 */
  degraded: boolean;
  /** 返回的是上次成功的缓存（非最新），前端弱提示。 */
  stale: boolean;
}

/**
 * 拉取最近 24h AI 资讯流。
 * 走后端代理（prd-api 缓存 ai-news-radar 静态源），前端不直连外站。
 */
export function getAiNewsLatest(): Promise<ApiResponse<AiNewsFeed>> {
  // 公共资讯端点（后端 [AllowAnonymous]），不依赖登录态。
  return apiRequest<AiNewsFeed>('/api/ai-news/latest', { method: 'GET', auth: false });
}

/**
 * 为指定资讯 id 批量抓取文章摘要片段（默认展示的「部分内容」）。
 * 命中缓存直接返回，未命中后端抓目标页 meta 描述。返回 id -> 摘要（仅含非空）。
 */
export function getAiNewsExcerpt(ids: string[]): Promise<ApiResponse<Record<string, string>>> {
  return apiRequest<Record<string, string>>('/api/ai-news/excerpt', {
    method: 'POST',
    body: { ids },
    auth: false,
  });
}

/**
 * 为指定资讯 id 批量获取「一句话 AI 解读」（备用：摘要抓不到时兜底）。
 * 需登录态（后端 [Authorize]）。返回 id -> 解读文本 的映射。
 */
export function getAiNewsCommentary(ids: string[]): Promise<ApiResponse<Record<string, string>>> {
  return apiRequest<Record<string, string>>('/api/ai-news/commentary', {
    method: 'POST',
    body: { ids },
  });
}
