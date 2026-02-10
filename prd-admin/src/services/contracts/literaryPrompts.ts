import type { ApiResponse } from '@/types/api';

/**
 * 文学创作提示词
 */
export interface LiteraryPrompt {
  id: string;
  ownerUserId: string;
  title: string;
  content: string;
  scenarioType?: string | null; // null/"global"=全局，"article-illustration"=文章配图，"image-gen"=图片生成
  order: number;
  isSystem: boolean;
  // 海鲜市场字段
  isPublic?: boolean;
  forkCount?: number;
  forkedFromId?: string | null;
  forkedFromUserId?: string | null;
  forkedFromUserName?: string | null;
  forkedFromUserAvatar?: string | null;
  isModifiedAfterFork?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 海鲜市场配置项（包含作者信息）
 */
export interface MarketplaceLiteraryPrompt {
  id: string;
  title: string;
  content: string;
  scenarioType?: string | null;
  forkCount: number;
  createdAt: string;
  ownerUserId: string;
  ownerUserName: string;
  ownerUserAvatar?: string | null;
}

/**
 * 获取提示词列表
 */
export type ListLiteraryPromptsContract = (input: {
  scenarioType?: string | null;
}) => Promise<ApiResponse<{ items: LiteraryPrompt[] }>>;

/**
 * 创建提示词
 */
export type CreateLiteraryPromptContract = (input: {
  title: string;
  content: string;
  scenarioType?: string | null;
}) => Promise<ApiResponse<{ prompt: LiteraryPrompt }>>;

/**
 * 更新提示词
 */
export type UpdateLiteraryPromptContract = (input: {
  id: string;
  title?: string;
  content?: string;
  scenarioType?: string | null;
  order?: number;
}) => Promise<ApiResponse<{ prompt: LiteraryPrompt }>>;

/**
 * 删除提示词
 */
export type DeleteLiteraryPromptContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ deleted: boolean }>>;

/**
 * 海鲜市场 - 获取公开配置列表
 */
export type ListLiteraryPromptsMarketplaceContract = (input: {
  scenarioType?: string | null;
  keyword?: string;
  sort?: 'hot' | 'new';
}) => Promise<ApiResponse<{ items: MarketplaceLiteraryPrompt[] }>>;

/**
 * 海鲜市场 - 发布配置
 */
export type PublishLiteraryPromptContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ prompt: LiteraryPrompt }>>;

/**
 * 海鲜市场 - 取消发布
 */
export type UnpublishLiteraryPromptContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ prompt: LiteraryPrompt }>>;

/**
 * AI 优化提示词：提取旧格式提示词中的风格描述部分，去除格式指令
 */
export type OptimizeLiteraryPromptContract = (input: {
  content: string;
}) => Promise<ApiResponse<{ optimizedContent: string }>>;

/**
 * 海鲜市场 - 免费下载（Fork）
 */
export type ForkLiteraryPromptContract = (input: {
  id: string;
  /** 可选的自定义名称，不传则使用原名称 */
  name?: string;
}) => Promise<ApiResponse<{ prompt: LiteraryPrompt }>>;
