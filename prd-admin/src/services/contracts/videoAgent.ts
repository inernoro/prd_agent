import type { ApiResponse } from '@/types/api';

/** 渲染模式：remotion=分镜+Remotion 合成（默认）；videogen=直接走 OpenRouter 视频大模型 */
export type VideoRenderMode = 'remotion' | 'videogen';

/** OpenRouter 视频模型 id（2026-04 OpenRouter 上架清单，按秒价升序） */
export const OPENROUTER_VIDEO_MODELS = [
  { id: 'alibaba/wan-2.6', label: 'Wan 2.6（阿里，1080p/24fps，~$0.04/秒，最便宜）', defaultDuration: 5 },
  { id: 'alibaba/wan-2.7', label: 'Wan 2.7（阿里，最新版）', defaultDuration: 5 },
  { id: 'bytedance/seedance-1-5-pro', label: 'Seedance 1.5 Pro（字节，1080p 含音频）', defaultDuration: 5 },
  { id: 'bytedance/seedance-2.0-fast', label: 'Seedance 2.0 Fast（字节，速度优先）', defaultDuration: 5 },
  { id: 'bytedance/seedance-2.0', label: 'Seedance 2.0（字节，精品版）', defaultDuration: 5 },
  { id: 'google/veo-3.1', label: 'Veo 3.1（Google，1080p/4K，含音频）', defaultDuration: 8 },
  { id: 'openai/sora-2-pro', label: 'Sora 2 Pro（OpenAI，~$0.30/秒，最贵最强）', defaultDuration: 5 },
] as const;

/**
 * 三档推荐模型（MVP：默认展示这三张卡片，用户不懂型号也能做决定）
 * 对应的 modelId 会直接作为 directVideoModel 传给后端；空串 = auto
 */
export const VIDEO_MODEL_TIERS = [
  {
    tier: 'economy',
    label: '经济',
    modelId: 'alibaba/wan-2.6',
    tagline: '日常使用',
    desc: '阿里 Wan 2.6，1080p/24fps，约 $0.04/秒',
  },
  {
    tier: 'balanced',
    label: '平衡',
    modelId: 'bytedance/seedance-2.0',
    tagline: '性价比推荐',
    desc: '字节 Seedance 2.0 精品版，含音频',
  },
  {
    tier: 'premium',
    label: '顶配',
    modelId: 'google/veo-3.1',
    tagline: '大片质感',
    desc: 'Google Veo 3.1，1080p/4K，电影级光影',
  },
] as const;

export type VideoModelTier = typeof VIDEO_MODEL_TIERS[number]['tier'];

/** 分镜模式的输入来源：article（技术文章）/ prd（产品需求文档） */
export type VideoInputSourceType = 'article' | 'prd';

/** 分镜状态 */
export type SceneItemStatus = 'Draft' | 'Generating' | 'Done' | 'Error';

/** 预览图状态 */
export type ImageStatus = 'idle' | 'running' | 'done' | 'error';

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
  /** 分镜预览视频 URL */
  imageUrl?: string;
  /** 预览视频渲染状态 */
  imageStatus: ImageStatus;
  /** AI 生成的背景图 URL */
  backgroundImageUrl?: string;
  /** 背景图生成状态 */
  backgroundImageStatus: ImageStatus;
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
  // ─── 直出模式字段（renderMode === 'videogen' 时有值） ───
  renderMode?: VideoRenderMode;
  directPrompt?: string;
  directVideoModel?: string;
  directAspectRatio?: string;
  directResolution?: string;
  directDuration?: number;
  directVideoJobId?: string;
  directVideoCost?: number;
  // ─── 分镜输入来源（PRD 模式专用） ───
  inputSourceType?: VideoInputSourceType;
  attachmentIds?: string[];
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
  articleMarkdown?: string;
  articleTitle?: string;
  systemPrompt?: string;
  styleDescription?: string;
  // ─── 直出模式字段（renderMode = 'videogen' 时这些字段生效，articleMarkdown 可省略） ───
  renderMode?: VideoRenderMode;
  directPrompt?: string;
  directVideoModel?: string;
  directAspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21';
  directResolution?: '480p' | '720p' | '1080p';
  directDuration?: number;
  // ─── 分镜模式输入来源（PRD 模式专用） ───
  inputSourceType?: VideoInputSourceType;
  attachmentIds?: string[];
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

export type GenerateScenePreviewContract = (
  runId: string,
  sceneIndex: number
) => Promise<ApiResponse<boolean>>;

export type GenerateSceneBgImageContract = (
  runId: string,
  sceneIndex: number
) => Promise<ApiResponse<boolean>>;
