import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';

export type ShortVideoTutorialStageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ShortVideoTutorialStage {
  key: string;
  label: string;
  status: ShortVideoTutorialStageStatus;
  message: string;
  at: string;
}

export interface ShortVideoTutorialRun {
  id: string;
  userId: string;
  videoUrl: string;
  platform: string;
  title: string;
  sourceMode: 'manual' | 'metadata-fallback' | string;
  status: 'running' | 'done' | 'failed' | string;
  stages: ShortVideoTutorialStage[];
  storeId?: string;
  entryId?: string;
  siteId?: string;
  shareId?: string;
  shareToken?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateShortVideoTutorialInput {
  videoUrl: string;
  sourceText?: string;
  title?: string;
  storeId?: string;
  style?: string;
}

export interface ShortVideoTutorialRunResponse {
  run: ShortVideoTutorialRun;
  storeId: string;
  entryId: string;
  siteId: string;
  siteUrl: string;
  shareUrl: string;
  analyticsUrl: string;
  documentUrl: string;
  shareViewCount: number;
}

export async function createShortVideoTutorialRun(input: CreateShortVideoTutorialInput) {
  return await apiRequest<ShortVideoTutorialRunResponse>(api.shortVideoTutorial.runs(), {
    method: 'POST',
    body: input,
  });
}

export async function getShortVideoTutorialRun(runId: string) {
  return await apiRequest<ShortVideoTutorialRun>(api.shortVideoTutorial.byId(runId), {
    method: 'GET',
  });
}
