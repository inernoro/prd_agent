import type { ApiResponse } from '@/types/api';
import type { ModelLabSelectedModel } from '@/services/contracts/modelLab';

export type ModelLabGroup = {
  id: string;
  ownerAdminId: string;
  name: string;
  models: ModelLabSelectedModel[];
  createdAt: string;
  updatedAt: string;
};

export type ListModelLabGroupsContract = (args?: { search?: string; limit?: number }) => Promise<ApiResponse<{ items: ModelLabGroup[] }>>;

export type UpsertModelLabGroupContract = (input: { id?: string; name: string; models: ModelLabSelectedModel[] }) => Promise<ApiResponse<ModelLabGroup>>;

export type DeleteModelLabGroupContract = (id: string) => Promise<ApiResponse<true>>;


