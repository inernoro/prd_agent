import type { ApiResponse } from '@/types/api';

export type DesktopAssetSkin = {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DesktopAssetKey = {
  id: string;
  key: string;
  kind: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminDesktopAssetUploadResponse = {
  skin: string; // '' 表示默认
  key: string;
  url: string;
  mime: string;
  sizeBytes: number;
};

export type ListDesktopAssetSkinsContract = () => Promise<ApiResponse<DesktopAssetSkin[]>>;
export type CreateDesktopAssetSkinContract = (input: { name: string; enabled?: boolean }) => Promise<ApiResponse<DesktopAssetSkin>>;
export type UpdateDesktopAssetSkinContract = (input: { id: string; enabled?: boolean }) => Promise<ApiResponse<DesktopAssetSkin>>;
export type DeleteDesktopAssetSkinContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type ListDesktopAssetKeysContract = () => Promise<ApiResponse<DesktopAssetKey[]>>;
export type CreateDesktopAssetKeyContract = (input: { key: string; kind?: string; description?: string | null }) => Promise<ApiResponse<DesktopAssetKey>>;
export type DeleteDesktopAssetKeyContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type UploadDesktopAssetContract = (input: { skin?: string | null; key: string; file: File }) => Promise<ApiResponse<AdminDesktopAssetUploadResponse>>;


