import type { ApiResponse } from '@/types/api';

export type WatermarkSpec = {
  enabled: boolean;
  text: string;
  fontKey: string;
  fontSizePx: number;
  opacity: number;
  posXRatio: number;
  posYRatio: number;
  iconEnabled: boolean;
  iconImageRef?: string | null;
  baseCanvasWidth: number;
  modelKey?: string | null;
  color?: string | null;
  /** 是否根据图片尺寸自适应缩放字体大小 */
  scaleWithImage?: boolean;
};

export type WatermarkSettings = {
  id?: string;
  ownerUserId?: string;
  enabled: boolean;
  spec: WatermarkSpec;
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

export type GetWatermarkContract = () => Promise<ApiResponse<WatermarkSettings>>;
export type PutWatermarkContract = (input: { spec: WatermarkSpec }) => Promise<ApiResponse<WatermarkSettings>>;
export type GetWatermarkFontsContract = () => Promise<ApiResponse<WatermarkFontInfo[]>>;
export type GetModelSizesContract = (input: { modelKey: string }) => Promise<ApiResponse<{ modelKey: string; sizes: ModelSizeInfo[] }>>;
