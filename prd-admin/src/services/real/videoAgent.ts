import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  CreateVideoGenRunContract,
  ListVideoGenRunsContract,
  GetVideoGenRunContract,
  CancelVideoGenRunContract,
  UpdateVideoSceneContract,
  RegenerateVideoSceneContract,
  TriggerVideoRenderContract,
  GenerateScenePreviewContract,
  GenerateSceneBgImageContract,
  VideoGenRun,
  VideoGenRunListItem,
  VideoGenScene,
} from '@/services/contracts/videoAgent';

export const createVideoGenRunReal: CreateVideoGenRunContract = async (input) => {
  return await apiRequest<{ runId: string }>(api.videoAgent.runs.create(), {
    method: 'POST',
    body: input,
  });
};

export const listVideoGenRunsReal: ListVideoGenRunsContract = async (input) => {
  const params = new URLSearchParams();
  if (input?.limit) params.set('limit', String(input.limit));
  if (input?.skip) params.set('skip', String(input.skip));
  const q = params.toString();
  return await apiRequest<{ total: number; items: VideoGenRunListItem[] }>(
    `${api.videoAgent.runs.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getVideoGenRunReal: GetVideoGenRunContract = async (runId) => {
  return await apiRequest<VideoGenRun>(api.videoAgent.runs.byId(runId), {
    method: 'GET',
  });
};

export const cancelVideoGenRunReal: CancelVideoGenRunContract = async (runId) => {
  return await apiRequest<boolean>(api.videoAgent.runs.cancel(runId), {
    method: 'POST',
  });
};

export const updateVideoSceneReal: UpdateVideoSceneContract = async (runId, sceneIndex, input) => {
  return await apiRequest<{ scene: VideoGenScene; totalDurationSeconds: number }>(
    api.videoAgent.scenes.update(runId, sceneIndex),
    { method: 'PUT', body: input }
  );
};

export const regenerateVideoSceneReal: RegenerateVideoSceneContract = async (runId, sceneIndex) => {
  return await apiRequest<boolean>(
    api.videoAgent.scenes.regenerate(runId, sceneIndex),
    { method: 'POST' }
  );
};

export const triggerVideoRenderReal: TriggerVideoRenderContract = async (runId) => {
  return await apiRequest<boolean>(api.videoAgent.runs.render(runId), {
    method: 'POST',
  });
};

export const generateScenePreviewReal: GenerateScenePreviewContract = async (runId, sceneIndex) => {
  return await apiRequest<boolean>(
    api.videoAgent.scenes.preview(runId, sceneIndex),
    { method: 'POST' }
  );
};

export const generateSceneBgImageReal: GenerateSceneBgImageContract = async (runId, sceneIndex) => {
  return await apiRequest<boolean>(
    api.videoAgent.scenes.generateBg(runId, sceneIndex),
    { method: 'POST' }
  );
};

/** 获取 SSE 事件流 URL */
export function getVideoGenStreamUrl(runId: string, afterSeq?: number): string {
  const base = api.videoAgent.runs.stream(runId);
  return afterSeq ? `${base}?afterSeq=${afterSeq}` : base;
}

/** 获取下载 URL */
export function getVideoGenDownloadUrl(runId: string, type: 'srt' | 'narration' | 'script'): string {
  return api.videoAgent.runs.download(runId, type);
}
