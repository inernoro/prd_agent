import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

export type ShituCategoryKey = 'culture' | 'incident' | 'policy' | 'award';

export interface ShituTabMeta {
  key: ShituCategoryKey;
  label: string;
  description: string;
  storeId: string;
  storeName: string;
  exampleQuestions: string[];
}

export interface ShituMeta {
  tabs: ShituTabMeta[];
  canManageKnowledge: boolean;
}

export interface ShituCategoryStore {
  storeId: string;
  storeName: string;
  canWrite: boolean;
  categoryKey: ShituCategoryKey;
  label: string;
}

export interface ShituQaHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ShituQaReferencePayload {
  requested: number;
  requestedStores?: number;
  requestedEntries?: number;
  included: number;
  totalChars: number;
  budget: number;
  skipped: string[];
  items: Array<{ index: number; entryId: string; storeId: string; title: string; chars: number }>;
}

export const SHITU_QA_STREAM_URL = '/api/shitu-agent/qa/stream';

export async function getShituMeta(): Promise<ApiResponse<ShituMeta>> {
  return apiRequest('/api/shitu-agent/meta');
}

export async function getShituCategoryStore(categoryKey: ShituCategoryKey): Promise<ApiResponse<ShituCategoryStore>> {
  return apiRequest(`/api/shitu-agent/stores/${categoryKey}`);
}
