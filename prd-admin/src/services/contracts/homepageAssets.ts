import type { ApiResponse } from '@/types/api';

export type HomepageAssetDto = {
  slot: string;
  url: string;
  mime: string;
  sizeBytes: number;
  updatedAt?: string | null;
};

export type HomepageAssetsMap = Record<string, HomepageAssetDto>;

export type ListHomepageAssetsContract = () => Promise<ApiResponse<HomepageAssetDto[]>>;
export type UploadHomepageAssetContract = (input: { slot: string; file: File }) => Promise<ApiResponse<HomepageAssetDto>>;
export type DeleteHomepageAssetContract = (input: { slot: string }) => Promise<ApiResponse<{ deleted: boolean }>>;
export type GetHomepageAssetsPublicContract = () => Promise<ApiResponse<HomepageAssetsMap>>;
