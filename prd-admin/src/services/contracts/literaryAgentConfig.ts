import type { ApiResponse } from '@/types/api';

/**
 * 文学创作 Agent 配置（兼容旧 API）
 */
export interface LiteraryAgentConfig {
  id: string;
  referenceImageSha256?: string | null;
  referenceImageUrl?: string | null;
  referenceImagePrompt?: string | null;
  activeConfigId?: string | null;
  activeConfigName?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 底图/参考图配置
 */
export interface ReferenceImageConfig {
  id: string;
  name: string;
  prompt: string;
  imageSha256?: string | null;
  imageUrl?: string | null;
  isActive: boolean;
  appKey: string;
  createdByAdminId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 获取文学创作 Agent 配置
 */
export type GetLiteraryAgentConfigContract = () => Promise<ApiResponse<LiteraryAgentConfig>>;

/**
 * 更新文学创作 Agent 配置
 */
export type UpdateLiteraryAgentConfigContract = (input: {
  referenceImageSha256?: string | null;
  referenceImageUrl?: string | null;
}) => Promise<ApiResponse<LiteraryAgentConfig>>;

/**
 * 上传底图/参考图（兼容旧 API）
 */
export type UploadReferenceImageContract = (file: File) => Promise<ApiResponse<{
  sha256: string;
  url: string;
  config: LiteraryAgentConfig;
}>>;

/**
 * 清除底图/参考图（兼容旧 API）
 */
export type ClearReferenceImageContract = () => Promise<ApiResponse<{
  cleared: boolean;
  config: LiteraryAgentConfig;
}>>;

// ========== 新的底图配置 API ==========

/**
 * 获取所有底图配置列表
 */
export type ListReferenceImageConfigsContract = () => Promise<ApiResponse<{
  items: ReferenceImageConfig[];
}>>;

/**
 * 创建底图配置
 */
export type CreateReferenceImageConfigContract = (input: {
  name: string;
  prompt?: string;
  file: File;
}) => Promise<ApiResponse<{
  config: ReferenceImageConfig;
}>>;

/**
 * 更新底图配置（名称和提示词）
 */
export type UpdateReferenceImageConfigContract = (input: {
  id: string;
  name?: string;
  prompt?: string;
}) => Promise<ApiResponse<{
  config: ReferenceImageConfig;
}>>;

/**
 * 更新底图配置的图片
 */
export type UpdateReferenceImageFileContract = (input: {
  id: string;
  file: File;
}) => Promise<ApiResponse<{
  config: ReferenceImageConfig;
}>>;

/**
 * 删除底图配置
 */
export type DeleteReferenceImageConfigContract = (input: {
  id: string;
}) => Promise<ApiResponse<{
  deleted: boolean;
}>>;

/**
 * 激活底图配置
 */
export type ActivateReferenceImageConfigContract = (input: {
  id: string;
}) => Promise<ApiResponse<{
  config: ReferenceImageConfig;
}>>;

/**
 * 取消激活底图配置
 */
export type DeactivateReferenceImageConfigContract = (input: {
  id: string;
}) => Promise<ApiResponse<{
  config: ReferenceImageConfig;
}>>;

/**
 * 获取当前激活的底图配置
 */
export type GetActiveReferenceImageConfigContract = () => Promise<ApiResponse<{
  config: ReferenceImageConfig | null;
}>>;
