import type { ApiResponse } from '@/types/api';

/**
 * 视频生成（纯 OpenRouter 直出模式）
 *
 * 2026-04-27 重构：原本支持 Remotion 拆分镜路径（VideoGenScene、SceneItemStatus、
 * RenderMode、UpdateVideoScene 等），现已彻底砍掉。视频生成只走 OpenRouter 视频
 * 大模型（Veo / Kling / Wan / Sora）一段直出。
 */

/** OpenRouter 视频模型 id（按秒价升序） */
export const OPENROUTER_VIDEO_MODELS = [
  { id: 'alibaba/wan-2.6', label: 'Wan 2.6（阿里，1080p/24fps，~$0.04/秒，最便宜）', defaultDuration: 5 },
  { id: 'alibaba/wan-2.7', label: 'Wan 2.7（阿里，最新版）', defaultDuration: 5 },
  { id: 'bytedance/seedance-1-5-pro', label: 'Seedance 1.5 Pro（字节，1080p 含音频）', defaultDuration: 5 },
  { id: 'bytedance/seedance-2.0-fast', label: 'Seedance 2.0 Fast（字节，速度优先）', defaultDuration: 5 },
  { id: 'bytedance/seedance-2.0', label: 'Seedance 2.0（字节，精品版）', defaultDuration: 5 },
  { id: 'google/veo-3.1', label: 'Veo 3.1（Google，1080p/4K，含音频）', defaultDuration: 8 },
  { id: 'openai/sora-2-pro', label: 'Sora 2 Pro（OpenAI，~$0.30/秒，最贵最强）', defaultDuration: 5 },
] as const;

/** 三档推荐模型（MVP：默认展示这三张卡片，用户不懂型号也能做决定） */
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

/** 视频生成模式 */
export type VideoGenMode = 'direct' | 'storyboard';

/** 单分镜状态 */
export type SceneItemStatus = 'Draft' | 'Generating' | 'Rendering' | 'Done' | 'Error';

/** storyboard 模式下的单分镜 */
export interface VideoGenScene {
  index: number;
  topic: string;
  prompt: string;
  status: SceneItemStatus;
  errorMessage?: string;
  model?: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  jobId?: string;
  cost?: number;
  videoUrl?: string;
}

/** 视频生成任务（含 direct + storyboard） */
export interface VideoGenRun {
  id: string;
  appKey: string;
  status: string;
  /** 创作模式 */
  mode: VideoGenMode;
  articleTitle?: string;
  // direct 模式 prompt | storyboard 模式可选拼接 prompt
  directPrompt: string;
  // storyboard 模式：原始文章
  articleMarkdown?: string;
  styleDescription?: string;
  // OpenRouter 默认参数（direct 直接用；storyboard 作为分镜默认值）
  directVideoModel?: string;
  directAspectRatio?: string;
  directResolution?: string;
  directDuration?: number;
  // 调用结果
  directVideoJobId?: string;
  directVideoCost?: number;
  // storyboard 模式分镜列表
  scenes: VideoGenScene[];
  // 产出
  videoAssetUrl?: string;
  // 进度
  currentPhase: string;
  phaseProgress: number;
  totalDurationSeconds: number;
  // 元数据
  ownerAdminId: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  cancelRequested: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/** 任务列表项（精简版，含 scenesCount/scenesReady = 0 兼容旧前端字段） */
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
  /** 已废弃：原分镜数量，恒为 0 */
  scenesCount: number;
  /** 已废弃：原已就绪分镜数量，恒为 0 */
  scenesReady: number;
}

export type CreateVideoGenRunContract = (input: {
  /** 创作模式：direct（默认）或 storyboard */
  mode?: VideoGenMode;
  /** direct 模式：视频描述 prompt（必填） */
  directPrompt?: string;
  /** storyboard 模式：文章/PRD 文本（必填） */
  articleMarkdown?: string;
  /** storyboard 模式：风格描述 */
  styleDescription?: string;
  /** 任务标题（可选） */
  articleTitle?: string;
  /** 模型 id */
  directVideoModel?: string;
  /** 宽高比 */
  directAspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21';
  /** 分辨率 */
  directResolution?: '480p' | '720p' | '1080p';
  /** 时长（秒） */
  directDuration?: number;
}) => Promise<ApiResponse<{ runId: string }>>;

/** 更新分镜（storyboard 模式编辑） */
export type UpdateVideoSceneContract = (
  runId: string,
  sceneIndex: number,
  input: {
    topic?: string;
    prompt?: string;
    model?: string;
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
  }
) => Promise<ApiResponse<boolean>>;

/** 触发 LLM 重新生成单镜 prompt */
export type RegenerateVideoSceneContract = (runId: string, sceneIndex: number) => Promise<ApiResponse<boolean>>;

/** 触发 OpenRouter 渲染单镜视频 */
export type RenderVideoSceneContract = (runId: string, sceneIndex: number) => Promise<ApiResponse<boolean>>;

export type ListVideoGenRunsContract = (input?: {
  limit?: number;
  skip?: number;
}) => Promise<ApiResponse<{ total: number; items: VideoGenRunListItem[] }>>;

export type GetVideoGenRunContract = (runId: string) => Promise<ApiResponse<VideoGenRun>>;

export type CancelVideoGenRunContract = (runId: string) => Promise<ApiResponse<boolean>>;
