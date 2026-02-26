import { api } from '@/services/api';
import type {
  CreateVideoGenRunContract,
  ListVideoGenRunsContract,
  GetVideoGenRunContract,
  CancelVideoGenRunContract,
} from '@/services/contracts/videoAgent';

const BASE = '/api/video-agent';

export const createVideoGenRunReal: CreateVideoGenRunContract = async (input) => {
  const { data } = await api.post(`${BASE}/runs`, input);
  return data;
};

export const listVideoGenRunsReal: ListVideoGenRunsContract = async (input) => {
  const params = new URLSearchParams();
  if (input?.limit) params.set('limit', String(input.limit));
  if (input?.skip) params.set('skip', String(input.skip));
  const { data } = await api.get(`${BASE}/runs?${params.toString()}`);
  return data;
};

export const getVideoGenRunReal: GetVideoGenRunContract = async (runId) => {
  const { data } = await api.get(`${BASE}/runs/${runId}`);
  return data;
};

export const cancelVideoGenRunReal: CancelVideoGenRunContract = async (runId) => {
  const { data } = await api.post(`${BASE}/runs/${runId}/cancel`);
  return data;
};

/** 获取 SSE 事件流 URL */
export function getVideoGenStreamUrl(runId: string, afterSeq?: number): string {
  const base = `${BASE}/runs/${runId}/stream`;
  return afterSeq ? `${base}?afterSeq=${afterSeq}` : base;
}

/** 获取下载 URL */
export function getVideoGenDownloadUrl(runId: string, type: 'srt' | 'narration' | 'script'): string {
  return `${BASE}/runs/${runId}/download/${type}`;
}
