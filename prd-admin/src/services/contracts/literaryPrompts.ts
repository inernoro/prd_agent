import type { ApiResponse } from './common';

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
  createdAt: string;
  updatedAt: string;
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
