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
