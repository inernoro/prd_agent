import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';

export type MyShareTargetType =
  | 'web_page'
  | 'report'
  | 'document_store'
  | 'workflow'
  | (string & {});

export interface MyShareItem {
  targetType: MyShareTargetType;
  token: string;
  shortSeq: number;
  title: string;
  subtitle?: string | null;
  accessLevel: string;
  viewCount: number;
  isRevoked: boolean;
  expiresAt?: string | null;
  createdAt: string;
  primaryPath: string;
  /** 该类型是否有可用前端展示页；false = 链接暂不可用（历史 debt），前端禁用打开/复制 */
  viewable: boolean;
}

export interface MySharesResponse {
  items: MyShareItem[];
  total: number;
  byType: Array<{ targetType: string; count: number }>;
}

/**
 * 列出当前用户跨 4 类（web_page / report / document_store / workflow）的所有分享。
 * 用于"我的分享"总管理面板。
 */
export async function listMyShares(params?: {
  targetType?: string;
  includeRevoked?: boolean;
}): Promise<ApiResponse<MySharesResponse>> {
  const sp = new URLSearchParams();
  if (params?.targetType) sp.set('targetType', params.targetType);
  if (params?.includeRevoked === false) sp.set('includeRevoked', 'false');
  const q = sp.toString();
  return apiRequest(`/api/my/shares${q ? `?${q}` : ''}`);
}
