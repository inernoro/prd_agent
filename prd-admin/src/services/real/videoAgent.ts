import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  CreateVideoGenRunContract,
  ListVideoGenRunsContract,
  GetVideoGenRunContract,
  CancelVideoGenRunContract,
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
