import type { ApiResponse } from '@/types/api';

/** 分镜状态 */
export type SceneItemStatus = 'Draft' | 'Generating' | 'Done' | 'Error';

/** 视频场景（分镜） */
export interface VideoGenScene {
  index: number;
  topic: string;
  narration: string;
  visualDescription: string;
  durationSeconds: number;
  sceneType: string;
  status: SceneItemStatus;
  errorMessage?: string;
}

/** 视频生成任务 */
export interface VideoGenRun {
  id: string;
  appKey: string;
  status: string;
  articleMarkdown: string;
  articleTitle?: string;
  systemPrompt?: string;
  styleDescription?: string;
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
  scenesCount: number;
  scenesReady: number;
}

export type CreateVideoGenRunContract = (input: {
  articleMarkdown: string;
  articleTitle?: string;
  systemPrompt?: string;
  styleDescription?: string;
}) => Promise<ApiResponse<{ runId: string }>>;

export type ListVideoGenRunsContract = (input?: {
  limit?: number;
  skip?: number;
}) => Promise<ApiResponse<{ total: number; items: VideoGenRunListItem[] }>>;

export type GetVideoGenRunContract = (runId: string) => Promise<ApiResponse<VideoGenRun>>;

export type CancelVideoGenRunContract = (runId: string) => Promise<ApiResponse<boolean>>;

export type UpdateVideoSceneContract = (
  runId: string,
  sceneIndex: number,
  input: {
    topic?: string;
    narration?: string;
    visualDescription?: string;
    sceneType?: string;
  }
) => Promise<ApiResponse<{ scene: VideoGenScene; totalDurationSeconds: number }>>;

export type RegenerateVideoSceneContract = (
  runId: string,
  sceneIndex: number
) => Promise<ApiResponse<boolean>>;

export type TriggerVideoRenderContract = (runId: string) => Promise<ApiResponse<boolean>>;
