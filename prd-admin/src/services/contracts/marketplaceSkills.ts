/**
 * 海鲜市场「技能」板块 API 合约。
 *
 * v1：纯分享，用户上传 zip 包 → 后端存 SKILL.md 预览 + 可选 LLM 自动生成 30 字摘要
 * 未来挂执行引擎时扩展 `manifestVersion` / `entryPoint` 字段即可。
 */

import type { ApiResponse } from '@/types/api';

/**
 * 海鲜市场卡片通用基础字段（与 `marketplaceTypes.tsx` 的 `MarketplaceItemBase` 对齐）
 * 后端 `MarketplaceSkillsController.ToDto` 产出这些字段，供通用 `MarketplaceCard` 消费
 */
export interface MarketplaceSkillDto {
  // === 通用海鲜市场字段 ===
  id: string;
  /** 所有下载次数（等同于 forkCount，满足 MarketplaceItemBase 契约） */
  forkCount: number;
  createdAt: string;
  updatedAt?: string;
  ownerUserId: string;
  ownerUserName: string;
  ownerUserAvatar?: string | null;

  // === 技能专属字段 ===
  title: string;
  description: string;
  iconEmoji: string;
  /** 封面图 CDN URL，空则走 iconEmoji 兜底 */
  coverImageUrl?: string | null;
  /** 预览地址：作者设置的展示 URL（托管站点或外部 URL） */
  previewUrl?: string | null;
  /** 预览地址来源：external | hosted_site */
  previewSource?: 'external' | 'hosted_site' | null;
  /** 若 previewSource=hosted_site，对应的 HostedSite.id */
  previewHostedSiteId?: string | null;
  tags: string[];
  zipUrl: string;
  zipSizeBytes: number;
  originalFileName: string;
  hasSkillMd: boolean;
  downloadCount: number;
  favoriteCount: number;
  isFavoritedByCurrentUser: boolean;
}

export interface MarketplaceSkillTagCount {
  tag: string;
  count: number;
}

// === Contracts ===

export type ListMarketplaceSkillsContract = (input: {
  keyword?: string;
  sort?: 'hot' | 'new';
  tag?: string;
}) => Promise<ApiResponse<{ items: MarketplaceSkillDto[] }>>;

/** 当前用户收藏的技能列表（供"我的空间"消费） */
export type ListMyFavoriteSkillsContract = () => Promise<
  ApiResponse<{ items: MarketplaceSkillDto[] }>
>;

export type GetMarketplaceSkillTagsContract = () => Promise<
  ApiResponse<{ tags: MarketplaceSkillTagCount[] }>
>;

export type UploadMarketplaceSkillContract = (input: {
  file: File;
  /** 为空则使用文件名（去扩展名）兜底 */
  title?: string;
  /** 为空则先规则提取 SKILL.md → 失败兜底 LLM 30 字摘要 → 回退到标题 */
  description?: string;
  iconEmoji?: string;
  tags?: string[];
  /** 封面图（可选）— 上传后落对象存储，卡片展示用 */
  coverImage?: File;
  /** 预览地址 URL；external 时必填，hosted_site 时可传空由后端解析 */
  previewUrl?: string;
  /** 预览地址来源：external（自填 URL）/ hosted_site（选 HostedSite） */
  previewSource?: 'external' | 'hosted_site';
  /** previewSource === 'hosted_site' 时必填 */
  previewHostedSiteId?: string;
}) => Promise<ApiResponse<{ item: MarketplaceSkillDto }>>;

export type ForkMarketplaceSkillContract = (input: {
  id: string;
  /** 与其他市场类型签名对齐（此处被忽略） */
  name?: string;
}) => Promise<ApiResponse<{ downloadUrl: string; fileName: string; item: MarketplaceSkillDto }>>;

export type FavoriteMarketplaceSkillContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ item: MarketplaceSkillDto }>>;

export type UnfavoriteMarketplaceSkillContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ item: MarketplaceSkillDto }>>;

export type DeleteMarketplaceSkillContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ deleted: boolean }>>;
