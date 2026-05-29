import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface CcasTemplateOption {
  key: string;
  label: string;
  description: string;
}

export interface CcasStylePreset {
  key: string;
  label: string;
  promptHint: string;
}

export interface CcasAssociationMode {
  key: string;
  label: string;
  description: string;
}

export interface CcasMeta {
  templates: CcasTemplateOption[];
  equipmentStyles: CcasStylePreset[];
  associationModes: CcasAssociationMode[];
}

export interface CcasEquipmentAsset {
  id: string;
  ownerUserId: string;
  equipmentType: string;
  styleKey: string;
  prompt: string;
  originalUserInput?: string | null;
  url: string;
  originalUrl?: string | null;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  model?: string | null;
  platformName?: string | null;
  isFavorite: boolean;
  createdAt: string;
}

export interface CcasFlowDiagramSummary {
  id: string;
  title: string;
  associationMode?: string | null;
  model?: string | null;
  platformName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CcasFlowDiagram extends CcasFlowDiagramSummary {
  ownerUserId: string;
  originalInput: string;
  nodesJson: string;
  edgesJson: string;
  groupsJson: string;
}

// ──────────────────────────────────────────────
// 元数据
// ──────────────────────────────────────────────

export async function getCcasMeta(): Promise<ApiResponse<CcasMeta>> {
  return apiRequest('/api/ccas-agent/meta');
}

// ──────────────────────────────────────────────
// 设备素材库
// ──────────────────────────────────────────────

export async function generateCcasEquipment(body: {
  equipmentType: string;
  styleKey: string;
  extraPrompt?: string;
  size?: string;
}): Promise<ApiResponse<{ asset: CcasEquipmentAsset; model: string; platform: string }>> {
  return apiRequest('/api/ccas-agent/equipment/generate', {
    method: 'POST',
    body,
  });
}

export async function listCcasEquipment(params: {
  equipmentType?: string;
  styleKey?: string;
  favoriteOnly?: boolean;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiResponse<{ items: CcasEquipmentAsset[]; total: number; page: number; pageSize: number }>> {
  const qs = new URLSearchParams();
  if (params.equipmentType) qs.set('equipmentType', params.equipmentType);
  if (params.styleKey) qs.set('styleKey', params.styleKey);
  if (params.favoriteOnly) qs.set('favoriteOnly', 'true');
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const q = qs.toString();
  return apiRequest(`/api/ccas-agent/equipment${q ? `?${q}` : ''}`);
}

export async function toggleCcasEquipmentFavorite(
  id: string,
  isFavorite: boolean
): Promise<ApiResponse<{ id: string; isFavorite: boolean }>> {
  return apiRequest(`/api/ccas-agent/equipment/${id}/favorite`, {
    method: 'POST',
    body: { isFavorite },
  });
}

export async function deleteCcasEquipment(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/ccas-agent/equipment/${id}`, { method: 'DELETE' });
}

// ──────────────────────────────────────────────
// 流程图持久化
// ──────────────────────────────────────────────

export async function saveCcasFlowDiagram(body: {
  id?: string;
  title: string;
  originalInput?: string;
  associationMode?: string;
  nodesJson: string;
  edgesJson: string;
  groupsJson: string;
  model?: string;
  platformName?: string;
}): Promise<ApiResponse<{ diagram: CcasFlowDiagram }>> {
  return apiRequest('/api/ccas-agent/flow/diagrams', {
    method: 'POST',
    body,
  });
}

export async function listCcasFlowDiagrams(
  page = 1,
  pageSize = 30
): Promise<ApiResponse<{ items: CcasFlowDiagramSummary[]; total: number; page: number; pageSize: number }>> {
  return apiRequest(`/api/ccas-agent/flow/diagrams?page=${page}&pageSize=${pageSize}`);
}

export async function getCcasFlowDiagram(id: string): Promise<ApiResponse<{ diagram: CcasFlowDiagram }>> {
  return apiRequest(`/api/ccas-agent/flow/diagrams/${id}`);
}

export async function deleteCcasFlowDiagram(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/ccas-agent/flow/diagrams/${id}`, { method: 'DELETE' });
}

// ──────────────────────────────────────────────
// SSE Endpoint URLs（前端用 fetch + ReadableStream 流式消费）
// 注：SSE 不能走 apiRequest（它会包成 JSON 响应）；需要在调用方手动 fetch + 读取流。
// ──────────────────────────────────────────────

export const CCAS_PRD_STREAM_URL = '/api/ccas-agent/prd/stream';
export const CCAS_FLOW_PARSE_STREAM_URL = '/api/ccas-agent/flow/parse-stream';
export const CCAS_QA_STREAM_URL = '/api/ccas-agent/qa/stream';

// ──────────────────────────────────────────────
// 智能客服请求 / SSE 事件类型（前端 fetch + ReadableStream 自行消费）
// ──────────────────────────────────────────────

export interface CcasQaHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface CcasQaRequest {
  message: string;
  history?: CcasQaHistoryItem[];
  referenceEntryIds?: string[];
  webSearch?: boolean;
  sessionId?: string;
}

/** SSE `reference` 事件 payload —— 后端注入实际命中的知识库条目 */
export interface CcasQaReferencePayload {
  requested: number;
  included: number;
  totalChars: number;
  budget: number;
  skipped: string[];
  /** 注入成功的条目摘要（按 [N] 角标顺序排列），用于前端引用脚注渲染 */
  items: Array<{ index: number; entryId: string; storeId: string; title: string; chars: number }>;
}

// ──────────────────────────────────────────────
// 知识库（document-store）轻量代理
// 只提供 PRD 引用知识库面板需要用的 3 个端点；
// 完整的知识库 CRUD 见 services/real/documentStore.ts
// ──────────────────────────────────────────────

export interface CcasKnowledgeStore {
  id: string;
  name: string;
  description?: string | null;
  appKey?: string | null;
  tags: string[];
  isPublic: boolean;
  documentCount: number;
  ownerId: string;
  updatedAt: string;
}

export interface CcasKnowledgeEntry {
  id: string;
  storeId: string;
  parentId?: string | null;
  isFolder: boolean;
  title: string;
  summary?: string | null;
  contentType?: string | null;
  fileSize?: number;
  tags?: string[] | null;
  createdAt: string;
  updatedAt?: string | null;
}

/** 列出当前用户的所有知识库空间（一次拉满 100 个，给抽屉用） */
export async function listMyKnowledgeStores(): Promise<ApiResponse<{ items: CcasKnowledgeStore[]; total: number }>> {
  return apiRequest('/api/document-store/stores?page=1&pageSize=100');
}

/** 列出某个空间的所有条目（all=true 返回全部，关键词支持搜索标题+摘要） */
export async function listKnowledgeEntries(
  storeId: string,
  keyword?: string
): Promise<ApiResponse<{ items: CcasKnowledgeEntry[]; total: number }>> {
  const qs = new URLSearchParams({ pageSize: '500', all: 'true' });
  if (keyword?.trim()) {
    qs.set('keyword', keyword.trim());
    qs.set('searchContent', 'true');
  }
  return apiRequest(`/api/document-store/stores/${encodeURIComponent(storeId)}/entries?${qs.toString()}`);
}

/** 获取条目正文（用于本地估算 token） */
export async function getKnowledgeEntryContent(
  entryId: string
): Promise<ApiResponse<{ entryId: string; title: string; content: string; hasContent: boolean }>> {
  return apiRequest(`/api/document-store/entries/${encodeURIComponent(entryId)}/content`);
}
