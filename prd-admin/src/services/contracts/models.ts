import type { ApiResponse } from '@/types/api';
import type { Model } from '@/types/admin';

export type GetModelsContract = () => Promise<ApiResponse<Model[]>>;

export type CreateModelInput = {
  name: string;
  modelName: string;
  platformId: string;
  enabled: boolean;
  group?: string;
};

export type UpdateModelInput = Partial<CreateModelInput> & {
  isMain?: boolean;
};

export type CreateModelContract = (input: CreateModelInput) => Promise<ApiResponse<Model>>;
export type UpdateModelContract = (id: string, input: UpdateModelInput) => Promise<ApiResponse<Model>>;
export type DeleteModelContract = (id: string) => Promise<ApiResponse<true>>;

export type TestModelContract = (id: string) => Promise<ApiResponse<{ success: boolean; duration: number; error?: string }>>;
export type SetMainModelContract = (id: string) => Promise<ApiResponse<true>>;
