import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

/** 短链目标系统类型 — 与后端 ShortLinkTargetTypes 对齐 */
export type ShortLinkTargetType =
  | 'web_page'
  | 'workflow'
  | 'defect'
  | 'report'
  | 'document_store'
  | 'toolbox'
  | (string & {});

export interface ShortLinkResolved {
  seq: number;
  targetType: ShortLinkTargetType;
  /** 各分享系统内的 Token，用于调用对应业务端点 */
  token: string;
  createdAt: string;
}

/** 按数字 Seq 解析短链，得到 (targetType, token) */
export async function resolveShortLink(seq: number | string): Promise<ApiResponse<ShortLinkResolved>> {
  return apiRequest(api.shortLinks.resolve(seq));
}
