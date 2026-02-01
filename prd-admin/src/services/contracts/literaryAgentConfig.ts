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

// ========== 模型查询 API（无参数，内部硬编码 appCallerCode）==========

/**
 * 模型池中的模型项
 */
export interface LiteraryAgentModelPoolItem {
  modelId: string;
  platformId: string;
  priority: number;
  healthStatus: string;
}

/**
 * 文学创作可用的模型池
 */
export interface LiteraryAgentModelPool {
  id: string;
  name: string;
  code: string;
  priority: number;
  modelType: string;
  isDefaultForType: boolean;
  description?: string | null;
  models: LiteraryAgentModelPoolItem[];
  /** 解析类型：DedicatedPool(专属池)、DefaultPool(默认池)、DirectModel(传统配置) */
  resolutionType: string;
  /** 是否为该应用的专属模型池 */
  isDedicated: boolean;
  /** 是否为该类型的默认模型池 */
  isDefault: boolean;
  /** 是否为传统配置模型 */
  isLegacy: boolean;
}

/**
 * 获取文学创作配图生成可用的模型池列表（无参数）
 * 兼容旧接口，根据是否有参考图自动选择 appCallerCode
 */
export type GetLiteraryAgentImageGenModelsContract = () => Promise<ApiResponse<LiteraryAgentModelPool[]>>;

/**
 * 获取所有模型池（文生图 + 图生图）的响应
 */
export interface LiteraryAgentAllModelsResponse {
  text2img: {
    appCallerCode: string;
    pools: LiteraryAgentModelPool[];
  };
  img2img: {
    appCallerCode: string;
    pools: LiteraryAgentModelPool[];
  };
}

/**
 * 获取所有配图模型池（文生图 + 图生图），一次性返回
 * 前端可用于同时显示两个模型状态
 */
export type GetLiteraryAgentAllModelsContract = () => Promise<ApiResponse<LiteraryAgentAllModelsResponse>>;

// ========== 图片生成 API（应用身份隔离）==========

import type { ImageGenRunStreamEvent, CreateImageGenRunInput } from './imageGen';

/**
 * 创建文学创作图片生成任务
 * 内部硬编码 appKey = "literary-agent"
 */
export type CreateLiteraryAgentImageGenRunContract = (params: {
  input: CreateImageGenRunInput;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ runId: string }>>;

/**
 * 取消文学创作图片生成任务
 */
export type CancelLiteraryAgentImageGenRunContract = (params: {
  runId: string;
}) => Promise<ApiResponse<boolean>>;

/**
 * SSE 流式获取文学创作图片生成任务事件
 */
export type StreamLiteraryAgentImageGenRunContract = (params: {
  runId: string;
  afterSeq?: number;
  onEvent: (evt: ImageGenRunStreamEvent) => void;
  signal: AbortSignal;
}) => Promise<ApiResponse<true>>;

/**
 * 带重试的 SSE 流式获取
 */
export type StreamLiteraryAgentImageGenRunWithRetryContract = (params: {
  runId: string;
  afterSeq?: number;
  onEvent: (evt: ImageGenRunStreamEvent) => void;
  signal: AbortSignal;
  maxAttempts?: number;
}) => Promise<ApiResponse<true>>;
