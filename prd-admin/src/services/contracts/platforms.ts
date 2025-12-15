import type { ApiResponse } from '@/types/api';
import type { Platform } from '@/types/admin';

export type GetPlatformsContract = () => Promise<ApiResponse<Platform[]>>;

export type CreatePlatformInput = {
  name: string;
  platformType: string;
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
};

export type UpdatePlatformInput = Partial<CreatePlatformInput>;

export type CreatePlatformContract = (input: CreatePlatformInput) => Promise<ApiResponse<Platform>>;
export type UpdatePlatformContract = (id: string, input: UpdatePlatformInput) => Promise<ApiResponse<Platform>>;
export type DeletePlatformContract = (id: string) => Promise<ApiResponse<true>>;
