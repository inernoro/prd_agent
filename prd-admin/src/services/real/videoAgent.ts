import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  CreateVideoGenRunContract,
  ListVideoGenRunsContract,
  GetVideoGenRunContract,
  CancelVideoGenRunContract,
  UpdateVideoSceneContract,
  RegenerateVideoSceneContract,
  RenderVideoSceneContract,
  VideoGenRun,
  VideoGenRunListItem,
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

// 视觉创作（视觉分镜台）专用：走 visual-agent 自有 video-gen 端点，
// 用 visual-agent 的权限/配额/appKey，避免 visual-agent-only 账号撞 video-agent 403。
export const createVisualVideoRunReal: CreateVideoGenRunContract = async (input) => {
  return await apiRequest<{ runId: string }>(api.visualAgent.videoGen.runs.create(), {
    method: 'POST',
    body: input,
  });
};

export const getVisualVideoRunReal: GetVideoGenRunContract = async (runId) => {
  return await apiRequest<VideoGenRun>(api.visualAgent.videoGen.runs.byId(runId), {
    method: 'GET',
  });
};

// 视觉分镜台专用取消：走 visual-agent 自有 cancel 端点（同 appKey/权限），
// 用于「离开分镜台/重新生成」时取消刚提交、已无法回到 UI 的视频 run，避免后台继续烧额度。
export const cancelVisualVideoRunReal: CancelVideoGenRunContract = async (runId) => {
  return await apiRequest<boolean>(api.visualAgent.videoGen.runs.cancel(runId), {
    method: 'POST',
  });
};

export const cancelVideoGenRunReal: CancelVideoGenRunContract = async (runId) => {
  return await apiRequest<boolean>(api.videoAgent.runs.cancel(runId), {
    method: 'POST',
  });
};

/** SSE 事件流 URL */
export function getVideoGenStreamUrl(runId: string, afterSeq?: number): string {
  const base = api.videoAgent.runs.stream(runId);
  return afterSeq ? `${base}?afterSeq=${afterSeq}` : base;
}

// ─── Storyboard 模式：分镜编辑 ───

export const updateVideoSceneReal: UpdateVideoSceneContract = async (runId, sceneIndex, input) => {
  return await apiRequest<boolean>(api.videoAgent.scenes.update(runId, sceneIndex), {
    method: 'PUT',
    body: input,
  });
};

export const regenerateVideoSceneReal: RegenerateVideoSceneContract = async (runId, sceneIndex) => {
  return await apiRequest<boolean>(api.videoAgent.scenes.regenerate(runId, sceneIndex), { method: 'POST' });
};

export const renderVideoSceneReal: RenderVideoSceneContract = async (runId, sceneIndex) => {
  return await apiRequest<boolean>(api.videoAgent.scenes.render(runId, sceneIndex), { method: 'POST' });
};
