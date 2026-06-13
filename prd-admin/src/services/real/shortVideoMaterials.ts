import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';

export type ShortVideoMaterialStageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ShortVideoMaterialStage {
  key: string;
  label: string;
  status: ShortVideoMaterialStageStatus;
  message: string;
  at: string;
}

export interface ShortVideoMaterialRun {
  id: string;
  userId: string;
  videoUrl: string;
  platform: string;
  title: string;
  sourceMode: 'manual' | 'tikhub-metadata' | 'metadata-fallback' | string;
  parserMessage?: string;
  status: 'running' | 'done' | 'failed' | string;
  stages: ShortVideoMaterialStage[];
  storeId?: string;
  entryId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateShortVideoMaterialInput {
  videoUrl: string;
  sourceText?: string;
  title?: string;
  storeId?: string;
}

export interface ShortVideoMaterialRunResponse {
  run: ShortVideoMaterialRun;
  storeId: string;
  entryIds: string[];
  sourceEntryId: string;
  transcriptEntryId: string;
  timelineEntryId: string;
  storeUrl: string;
  sourceUrl: string;
  transcriptUrl: string;
  timelineUrl: string;
}

export async function createShortVideoMaterialRun(input: CreateShortVideoMaterialInput) {
  return await apiRequest<ShortVideoMaterialRunResponse>(api.shortVideoMaterials.runs(), {
    method: 'POST',
    body: input,
  });
}

export async function getShortVideoMaterialRun(runId: string) {
  return await apiRequest<ShortVideoMaterialRun>(api.shortVideoMaterials.byId(runId), {
    method: 'GET',
  });
}
