import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ─── Types（与后端 WebFolder.cs 镜像；enum 走字符串联合，对应 enum-ripple 规则）───

export type WebFolderGeneratorType = 'none' | 'skill' | 'markdown';
export type WebFolderGenerateTarget = 'web' | 'document-store';

export interface WebFolder {
  id: string;
  name: string;
  description?: string;
  sortOrder: number;
  generatorType: WebFolderGeneratorType;
  generatorSkillId?: string;
  generatorMarkdown?: string;
  generateTarget: WebFolderGenerateTarget;
  generateStoreId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建/更新文件夹的入参（与后端 WebFolderRequest 对齐） */
export interface WebFolderInput {
  name: string;
  description?: string;
  sortOrder?: number;
  generatorType?: WebFolderGeneratorType;
  generatorSkillId?: string;
  generatorMarkdown?: string;
  generateTarget?: WebFolderGenerateTarget;
  generateStoreId?: string;
}

/** 「按文件夹生成」结果。generated=false 时带 reason；成功时按 target 携带 site/entry 信息 */
export interface GenerateResult {
  generated: boolean;
  reason?: string;
  target?: WebFolderGenerateTarget;
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

export async function listWebFolders(): Promise<ApiResponse<{ items: WebFolder[] }>> {
  return apiRequest(api.webFolders.list(), { method: 'GET' });
}

export async function createWebFolder(input: WebFolderInput): Promise<ApiResponse<WebFolder>> {
  return apiRequest(api.webFolders.create(), { method: 'POST', body: input });
}

export async function updateWebFolder(
  id: string,
  patch: WebFolderInput,
): Promise<ApiResponse<WebFolder>> {
  return apiRequest(api.webFolders.detail(encodeURIComponent(id)), { method: 'PUT', body: patch });
}

export async function deleteWebFolder(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.webFolders.detail(encodeURIComponent(id)), { method: 'DELETE' });
}

export async function generateFromFolder(id: string): Promise<ApiResponse<GenerateResult>> {
  return apiRequest(api.webFolders.generate(encodeURIComponent(id)), { method: 'POST' });
}
