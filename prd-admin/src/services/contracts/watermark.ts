import type { ApiResponse } from '@/types/api';

export type WatermarkSpec = {
  id: string;
  name: string;
  enabled: boolean;
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
  backgroundEnabled?: boolean;
  baseCanvasWidth: number;
  modelKey?: string | null;
  color?: string | null;
  textColor?: string | null;
  backgroundColor?: string | null;
};

export type WatermarkSettings = {
  id?: string;
  ownerUserId?: string;
  enabled: boolean;
  activeSpecId?: string;
  specs?: WatermarkSpec[];
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
export type PutWatermarkContract = (input: {
  enabled?: boolean;
  activeSpecId?: string;
  specs?: WatermarkSpec[];
  spec?: WatermarkSpec;
}) => Promise<ApiResponse<WatermarkSettings>>;
export type GetWatermarkFontsContract = () => Promise<ApiResponse<WatermarkFontInfo[]>>;
export type GetModelSizesContract = (input: { modelKey: string }) => Promise<ApiResponse<{ modelKey: string; sizes: ModelSizeInfo[] }>>;
export type UploadWatermarkFontContract = (input: { file: File; displayName?: string }) => Promise<ApiResponse<WatermarkFontInfo>>;
export type DeleteWatermarkFontContract = (input: { fontKey: string }) => Promise<ApiResponse<{ deleted: boolean }>>;
