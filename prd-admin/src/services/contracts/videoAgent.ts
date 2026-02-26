import type { ApiResponse } from '@/types/api';

/** 视频场景 */
export interface VideoGenScene {
  index: number;
  topic: string;
  narration: string;
  visualDescription: string;
  durationSeconds: number;
  sceneType: string;
}

/** 视频生成任务 */
export interface VideoGenRun {
  id: string;
  appKey: string;
  status: string;
  articleMarkdown: string;
  articleTitle?: string;
  scenes: VideoGenScene[];
  totalDurationSeconds: number;
  scriptMarkdown?: string;
  videoAssetUrl?: string;
  srtContent?: string;
  narrationDoc?: string;
  currentPhase: string;
  phaseProgress: number;
  ownerAdminId: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  cancelRequested: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/** 任务列表项（精简版） */
export interface VideoGenRunListItem {
  id: string;
  status: string;
  articleTitle?: string;
  currentPhase: string;
  phaseProgress: number;
  totalDurationSeconds: number;
  videoAssetUrl?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  errorMessage?: string;
}

export type CreateVideoGenRunContract = (input: {
  articleMarkdown: string;
  articleTitle?: string;
}) => Promise<ApiResponse<{ runId: string }>>;

export type ListVideoGenRunsContract = (input?: {
  limit?: number;
  skip?: number;
}) => Promise<ApiResponse<{ total: number; items: VideoGenRunListItem[] }>>;

export type GetVideoGenRunContract = (runId: string) => Promise<ApiResponse<VideoGenRun>>;

export type CancelVideoGenRunContract = (runId: string) => Promise<ApiResponse<boolean>>;
