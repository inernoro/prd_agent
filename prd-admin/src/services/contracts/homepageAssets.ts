import type { ApiResponse } from '@/types/api';

export type HomepageAssetDto = {
  slot: string;
  url: string;
  mime: string;
  sizeBytes: number;
  updatedAt?: string | null;
  /** 生成这张图用的提示词；手工上传的没有 */
  prompt?: string | null;
};

export type HomepageAssetsMap = Record<string, HomepageAssetDto>;

export type ListHomepageAssetsContract = () => Promise<ApiResponse<HomepageAssetDto[]>>;
export type UploadHomepageAssetContract = (input: { slot: string; file: File }) => Promise<ApiResponse<HomepageAssetDto>>;
export type DeleteHomepageAssetContract = (input: { slot: string }) => Promise<ApiResponse<{ deleted: boolean }>>;
export type GetHomepageAssetsPublicContract = () => Promise<ApiResponse<HomepageAssetsMap>>;

/** 把一次生图任务的产物挂到某个首页槽位上 */
export type AdoptHomepageAssetInput = {
  slot: string;
  runId: string;
  itemIndex: number;
  imageIndex?: number;
  prompt?: string;
};
export type AdoptHomepageAssetContract = (input: AdoptHomepageAssetInput) => Promise<ApiResponse<HomepageAssetDto>>;
