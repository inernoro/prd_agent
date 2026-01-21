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
  borderEnabled?: boolean;
  borderColor?: string | null;
  borderWidth?: number;
  backgroundEnabled?: boolean;
  roundedBackgroundEnabled?: boolean;
  cornerRadius?: number;
  baseCanvasWidth: number;
  textColor?: string | null;
  backgroundColor?: string | null;
  previewUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

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
  borderEnabled?: boolean;
  borderColor?: string | null;
  borderWidth?: number;
  backgroundEnabled?: boolean;
  roundedBackgroundEnabled?: boolean;
  cornerRadius?: number;
  baseCanvasWidth?: number;
  textColor?: string | null;
  backgroundColor?: string | null;
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
