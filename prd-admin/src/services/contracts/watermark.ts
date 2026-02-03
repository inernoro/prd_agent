import type { ApiResponse } from '@/types/api';

/**
 * 独立的水印配置（每条记录是一个完整的水印配置）
 */
export type WatermarkConfig = {
  id: string;
  userId?: string;
  name: string;
  appKeys: string[];
  text: string;
  fontKey: string;
  fontSizePx: number;
  opacity: number;
  positionMode: 'pixel' | 'ratio';
  anchor: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  offsetX: number;
  offsetY: number;
  iconEnabled: boolean;
  iconImageRef?: string | null;
  iconPosition?: 'left' | 'right' | 'top' | 'bottom';
  iconGapPx?: number;
  iconScale?: number;
  borderEnabled?: boolean;
  borderColor?: string | null;
  borderWidth?: number;
  backgroundEnabled?: boolean;
  roundedBackgroundEnabled?: boolean;
  cornerRadius?: number;
  baseCanvasWidth: number;
  adaptiveScaleMode?: 0 | 1 | 2 | 3 | 4;
  textColor?: string | null;
  backgroundColor?: string | null;
  previewBackgroundImageRef?: string | null;
  previewUrl?: string | null;
  // 海鲜市场字段
  isPublic?: boolean;
  forkCount?: number;
  forkedFromId?: string | null;
  forkedFromUserId?: string | null;
  forkedFromUserName?: string | null;
  forkedFromUserAvatar?: string | null;
  isModifiedAfterFork?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * 海鲜市场水印配置（包含作者信息）
 */
export interface MarketplaceWatermarkConfig {
  id: string;
  name: string;
  text: string;
  fontKey: string;
  fontSizePx: number;
  previewUrl?: string | null;
  forkCount: number;
  createdAt: string;
  ownerUserId: string;
  ownerUserName: string;
  ownerUserAvatar?: string | null;
}

export type WatermarkFontInfo = {
  fontKey: string;
  displayName: string;
  fontFamily: string;
  fontFileUrl: string;
};

export type ModelSizeInfo = {
  width: number;
  height: number;
  label: string;
  ratio: number;
};

/**
 * 创建水印配置的输入
 */
export type CreateWatermarkInput = {
  name?: string;
  text?: string;
  fontKey?: string;
  fontSizePx?: number;
  opacity?: number;
  positionMode?: 'pixel' | 'ratio';
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  offsetX?: number;
  offsetY?: number;
  iconEnabled?: boolean;
  iconImageRef?: string | null;
  iconPosition?: 'left' | 'right' | 'top' | 'bottom';
  iconGapPx?: number;
  iconScale?: number;
  borderEnabled?: boolean;
  borderColor?: string | null;
  borderWidth?: number;
  backgroundEnabled?: boolean;
  roundedBackgroundEnabled?: boolean;
  cornerRadius?: number;
  baseCanvasWidth?: number;
  adaptiveScaleMode?: 0 | 1 | 2 | 3 | 4;
  textColor?: string | null;
  backgroundColor?: string | null;
  previewBackgroundImageRef?: string | null;
};

/**
 * 更新水印配置的输入
 */
export type UpdateWatermarkInput = CreateWatermarkInput;

// API 合约类型
export type GetWatermarksContract = () => Promise<ApiResponse<WatermarkConfig[]>>;
export type GetWatermarkByAppContract = (input: { appKey: string }) => Promise<ApiResponse<WatermarkConfig | null>>;
export type CreateWatermarkContract = (input: CreateWatermarkInput) => Promise<ApiResponse<WatermarkConfig>>;
export type UpdateWatermarkContract = (input: { id: string } & UpdateWatermarkInput) => Promise<ApiResponse<WatermarkConfig>>;
export type DeleteWatermarkContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;
export type BindWatermarkAppContract = (input: { id: string; appKey: string }) => Promise<ApiResponse<WatermarkConfig>>;
export type UnbindWatermarkAppContract = (input: { id: string; appKey: string }) => Promise<ApiResponse<WatermarkConfig>>;

export type GetWatermarkFontsContract = () => Promise<ApiResponse<WatermarkFontInfo[]>>;
export type GetModelSizesContract = (input: { modelKey: string }) => Promise<ApiResponse<{ modelKey: string; sizes: ModelSizeInfo[] }>>;
export type UploadWatermarkFontContract = (input: { file: File; displayName?: string }) => Promise<ApiResponse<WatermarkFontInfo>>;
export type DeleteWatermarkFontContract = (input: { fontKey: string }) => Promise<ApiResponse<{ deleted: boolean }>>;
export type UploadWatermarkIconContract = (input: { file: File }) => Promise<ApiResponse<{ url: string }>>;

/**
 * 海鲜市场 - 获取公开水印配置列表
 */
export type ListWatermarksMarketplaceContract = (input: {
  keyword?: string;
  sort?: 'hot' | 'new';
}) => Promise<ApiResponse<{ items: MarketplaceWatermarkConfig[] }>>;

/**
 * 海鲜市场 - 发布水印配置
 */
export type PublishWatermarkContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ config: WatermarkConfig }>>;

/**
 * 海鲜市场 - 取消发布
 */
export type UnpublishWatermarkContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ config: WatermarkConfig }>>;

/**
 * 海鲜市场 - 免费下载（Fork）
 */
export type ForkWatermarkContract = (input: {
  id: string;
  /** 可选的自定义名称，不传则使用原名称 */
  name?: string;
}) => Promise<ApiResponse<{ config: WatermarkConfig }>>;
