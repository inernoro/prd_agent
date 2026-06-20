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

/** 短视频展示卡片（后端从平台原始元数据抽取的干净字段，前端直接渲染）。 */
export interface ShortVideoCard {
  coverUrl?: string | null;
  videoUrl?: string | null;
  title: string;
  authorName?: string | null;
  authorAvatarUrl?: string | null;
  platform: string;
  durationSec?: number | null;
  hashtags?: string[] | null;
  likeCount?: number | null;
  commentCount?: number | null;
  shareCount?: number | null;
  collectCount?: number | null;
  playCount?: number | null;
}

export interface ShortVideoMaterialRun {
  id: string;
  userId: string;
  videoUrl: string;
  platform: string;
  title: string;
  requestedTitle?: string;
  inputSourceText?: string;
  sourceMode: 'manual' | 'tikhub-video' | 'metadata-fallback' | string;
  parserMessage?: string;
  parsedMetadataJson?: string | null;
  sourceVideoUrl?: string | null;
  card?: ShortVideoCard | null;
  status: 'queued' | 'running' | 'done' | 'failed' | string;
  stages: ShortVideoMaterialStage[];
  storeId?: string;
  entryId?: string;
  sourceEntryId?: string;
  transcriptEntryId?: string;
  timelineEntryId?: string;
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
