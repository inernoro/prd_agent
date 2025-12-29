import type { ApiResponse } from '@/types/api';

export type ImageMasterSession = {
  id: string;
  ownerUserId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ImageMasterMessage = {
  id: string;
  sessionId: string;
  ownerUserId: string;
  role: 'User' | 'Assistant';
  content: string;
  createdAt: string;
};

export type ImageAsset = {
  id: string;
  ownerUserId: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  url: string;
  prompt?: string | null;
  createdAt: string;
};

export type CreateImageMasterSessionContract = (input: { title?: string }) => Promise<ApiResponse<{ session: ImageMasterSession }>>;
export type ListImageMasterSessionsContract = (input?: { limit?: number }) => Promise<ApiResponse<{ items: ImageMasterSession[] }>>;
export type GetImageMasterSessionContract = (input: { id: string; messageLimit?: number; assetLimit?: number }) => Promise<ApiResponse<{ session: ImageMasterSession; messages: ImageMasterMessage[]; assets: ImageAsset[] }>>;
export type AddImageMasterMessageContract = (input: { sessionId: string; role: 'User' | 'Assistant'; content: string }) => Promise<ApiResponse<{ message: ImageMasterMessage }>>;
export type UploadImageAssetContract = (input: { data?: string; sourceUrl?: string; prompt?: string; width?: number; height?: number }) => Promise<ApiResponse<{ asset: ImageAsset }>>;
export type DeleteImageMasterAssetContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;


