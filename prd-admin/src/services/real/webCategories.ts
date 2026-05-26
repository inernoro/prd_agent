import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ─── Types（与后端 WebCategory.cs 镜像；enum 走字符串联合，对应 enum-ripple 规则）───

export type WebCategoryGeneratorType = 'none' | 'skill' | 'markdown';
export type WebCategoryGenerateTarget = 'web' | 'document-store';

export interface WebCategory {
  id: string;
  name: string;
  description?: string;
  sortOrder: number;
  generatorType: WebCategoryGeneratorType;
  generatorSkillId?: string;
  generatorMarkdown?: string;
  generateTarget: WebCategoryGenerateTarget;
  generateStoreId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建/更新分类的入参（与后端 WebCategoryRequest 对齐） */
export interface WebCategoryInput {
  name: string;
  description?: string;
  sortOrder?: number;
  generatorType?: WebCategoryGeneratorType;
  generatorSkillId?: string;
  generatorMarkdown?: string;
  generateTarget?: WebCategoryGenerateTarget;
  generateStoreId?: string;
}

/** 「按分类生成」结果。generated=false 时带 reason；成功时按 target 携带 site/entry 信息 */
export interface GenerateResult {
  generated: boolean;
  reason?: string;
  target?: WebCategoryGenerateTarget;
  title?: string;
  // web 目标
  siteId?: string;
  siteUrl?: string;
  entryFile?: string;
  // document-store 目标
  storeId?: string;
  entryId?: string;
  documentId?: string;
}

// ─── CRUD + 生成 ───

export async function listWebCategories(): Promise<ApiResponse<{ items: WebCategory[] }>> {
  return apiRequest(api.webCategories.list(), { method: 'GET' });
}

export async function createWebCategory(input: WebCategoryInput): Promise<ApiResponse<WebCategory>> {
  return apiRequest(api.webCategories.create(), { method: 'POST', body: input });
}

export async function updateWebCategory(
  id: string,
  patch: WebCategoryInput,
): Promise<ApiResponse<WebCategory>> {
  return apiRequest(api.webCategories.detail(encodeURIComponent(id)), { method: 'PUT', body: patch });
}

export async function deleteWebCategory(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.webCategories.detail(encodeURIComponent(id)), { method: 'DELETE' });
}

export async function generateFromCategory(id: string): Promise<ApiResponse<GenerateResult>> {
  return apiRequest(api.webCategories.generate(encodeURIComponent(id)), { method: 'POST' });
}
