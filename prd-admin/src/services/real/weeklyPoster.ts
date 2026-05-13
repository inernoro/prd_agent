import { apiRequest } from '@/services/real/apiClient';

// ============ Types（与后端 WeeklyPosterController DTO 对齐） ============

export type WeeklyPosterStatus = 'draft' | 'published' | 'archived';

export type WeeklyPosterTemplateKey = 'release' | 'hotfix' | 'promo' | 'sale';
export type WeeklyPosterPresentationMode =
  | 'static'
  | 'fullscreen'
  | 'interactive'
  | 'ad-4-3'
  | 'ad-rich-text'
  | 'feed-card';
export type WeeklyPosterSourceType =
  | 'changelog-current-week'
  | 'github-commits'
  | 'knowledge-base'
  | 'freeform';

export interface WeeklyPosterKnowledgeEntryMeta {
  id: string;
  title: string;
  summary?: string | null;
  contentChars: number;
  storeId: string;
}

export interface WeeklyPosterTemplateMeta {
  key: WeeklyPosterTemplateKey;
  label: string;
  description: string;
  emoji: string;
  defaultPages: number;
  accentPalette: string[];
}

export interface WeeklyPosterAutopilotResult {
  poster: WeeklyPoster;
  model?: string | null;
  platform?: string | null;
  sourceSummary?: string | null;
}

export interface WeeklyPosterAutopilotInput {
  templateKey?: WeeklyPosterTemplateKey;
  sourceType?: WeeklyPosterSourceType;
  freeformContent?: string;
  sourceRef?: string;
  weekKey?: string;
  pageCount?: number;
  ctaUrl?: string;
}

export interface PosterPageStats {
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  collects?: number | null;
  plays?: number | null;
}

export interface TranscriptCue {
  /** 开始时间（秒，相对视频起点） */
  startSec: number;
  /** 结束时间（秒） */
  endSec: number;
  text: string;
}

export interface WeeklyPosterPage {
  /** 页码,从 0 开始 */
  order: number;
  title: string;
  /** 正文,支持 markdown 或纯文本(换行自动 break) */
  body: string;
  /** 配图提示词 */
  imagePrompt: string;
  /** 主图 URL(AI 生成 / 用户上传),空值走渐变兜底 */
  imageUrl?: string | null;
  /** 副图 URL(可选:用于图文叠加版式的小插图) */
  secondaryImageUrl?: string | null;
  /** 卡片主色调,空值走默认紫 */
  accentColor?: string | null;

  // ── feed-card 版式新增字段（全部可选向下兼容）──
  authorName?: string | null;
  authorAvatarUrl?: string | null;
  /** 来源平台：tiktok / douyin / bilibili / xiaohongshu / youtube */
  platform?: string | null;
  /** 视频时长（秒） */
  durationSec?: number | null;
  /** 话题标签数组（去掉 # 前缀） */
  hashtags?: string[] | null;
  /** 互动统计 */
  stats?: PosterPageStats | null;
  /** 带时间戳字幕（feed-card 模式播放时按 video.currentTime 同步显示当前句） */
  transcriptCues?: TranscriptCue[] | null;
}

export interface WeeklyPoster {
  id: string;
  /** ISO 周标识 "2026-W17" */
  weekKey: string;
  title: string;
  subtitle?: string | null;
  status: WeeklyPosterStatus;
  templateKey: WeeklyPosterTemplateKey;
  presentationMode: WeeklyPosterPresentationMode;
  sourceType?: string | null;
  sourceRef?: string | null;
  pages: WeeklyPosterPage[];
  ctaText: string;
  ctaUrl: string;
  publishedAt?: string | null;
  updatedAt: string;
}

export interface WeeklyPosterListItem {
  id: string;
  title: string;
  weekKey: string;
  status: WeeklyPosterStatus;
  pageCount: number;
  updatedAt: string;
  publishedAt?: string | null;
}

export interface WeeklyPosterListView {
  total: number;
  page: number;
  pageSize: number;
  items: WeeklyPosterListItem[];
}

export interface WeeklyPosterUpsertInput {
  weekKey?: string;
  title?: string;
  subtitle?: string | null;
  templateKey?: WeeklyPosterTemplateKey;
  presentationMode?: WeeklyPosterPresentationMode;
  sourceType?: string | null;
  sourceRef?: string | null;
  pages?: WeeklyPosterPage[];
  ctaText?: string;
  ctaUrl?: string;
}

export interface WeeklyPosterImageRun {
  runId: string;
  status: string;
  total: number;
  reused: boolean;
}

export interface WeeklyPosterImageRunStatus {
  runId: string;
  posterId: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  poster?: WeeklyPoster | null;
}

// ============ API Calls ============

/**
 * 主页拉取当前待展示的海报(最新一篇 published)。
 * 后端会过滤掉当前用户已经标记 seen 的海报，所以拉到 null = "没有新的可弹"。
 */
export async function getCurrentWeeklyPoster() {
  return await apiRequest<WeeklyPoster | null>('/api/weekly-posters/current');
}

/**
 * 标记当前用户已看过这张海报。前端弹窗展示 1.5s 后调用，写入后端 SeenBy。
 * 之后这张海报不再返回给当前用户；有新海报（不同 id）发布时仍会弹一次。
 */
export async function markWeeklyPosterSeen(posterId: string) {
  return await apiRequest<{ ok: boolean }>(`/api/weekly-posters/${posterId}/mark-seen`, {
    method: 'POST',
  });
}

/** 管理端:列出所有海报 */
export async function listWeeklyPosters(opts?: {
  status?: WeeklyPosterStatus;
  page?: number;
  pageSize?: number;
}) {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.page) params.set('page', String(opts.page));
  if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return await apiRequest<WeeklyPosterListView>(`/api/weekly-posters${suffix}`);
}

export async function getWeeklyPoster(id: string) {
  return await apiRequest<WeeklyPoster>(`/api/weekly-posters/${encodeURIComponent(id)}`);
}

export async function createWeeklyPoster(input: WeeklyPosterUpsertInput) {
  return await apiRequest<WeeklyPoster>('/api/weekly-posters', {
    method: 'POST',
    body: input,
  });
}

export async function updateWeeklyPoster(id: string, input: WeeklyPosterUpsertInput) {
  return await apiRequest<WeeklyPoster>(`/api/weekly-posters/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
}

export async function deleteWeeklyPoster(id: string) {
  return await apiRequest<{ deleted: boolean }>(`/api/weekly-posters/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function publishWeeklyPoster(id: string) {
  return await apiRequest<WeeklyPoster>(`/api/weekly-posters/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
  });
}

export async function unpublishWeeklyPoster(id: string) {
  return await apiRequest<{ unpublished: boolean }>(
    `/api/weekly-posters/${encodeURIComponent(id)}/unpublish`,
    { method: 'POST' }
  );
}

// ───── AI 向导 ─────

export async function listWeeklyPosterTemplates() {
  return await apiRequest<{ items: WeeklyPosterTemplateMeta[] }>(
    '/api/weekly-posters/templates'
  );
}

/** 一键生成海报草稿(读数据源 + LLM 结构化) */
export async function autopilotWeeklyPoster(input: WeeklyPosterAutopilotInput) {
  return await apiRequest<WeeklyPosterAutopilotResult>(
    '/api/weekly-posters/autopilot',
    { method: 'POST', body: input }
  );
}

/** 知识库文档列表(供向导页选择器使用) */
export async function listWeeklyPosterKnowledgeEntries(keyword?: string, limit = 50) {
  const params = new URLSearchParams();
  if (keyword) params.set('keyword', keyword);
  params.set('limit', String(limit));
  return await apiRequest<{ items: WeeklyPosterKnowledgeEntryMeta[] }>(
    `/api/weekly-posters/knowledge-entries?${params.toString()}`
  );
}

/** 为指定页生成/重生图片(同步,约 10-30 秒) */
export async function generateWeeklyPosterPageImage(
  posterId: string,
  order: number,
  overridePrompt?: string,
) {
  return await apiRequest<WeeklyPoster>(
    `/api/weekly-posters/${encodeURIComponent(posterId)}/pages/${order}/generate-image`,
    { method: 'POST', body: overridePrompt ? { overridePrompt } : {} }
  );
}

/** 创建后台批量生图任务。服务端负责继续生成并回填页面，浏览器关闭不影响任务执行。 */
export async function generateWeeklyPosterImages(
  posterId: string,
  input?: { regenerate?: boolean; maxConcurrency?: number },
) {
  return await apiRequest<WeeklyPosterImageRun>(
    `/api/weekly-posters/${encodeURIComponent(posterId)}/generate-images`,
    { method: 'POST', body: input ?? {} }
  );
}

/** 查询周报海报后台生图任务状态，并返回最新海报。 */
export async function getWeeklyPosterImageRun(runId: string) {
  return await apiRequest<WeeklyPosterImageRunStatus>(
    `/api/weekly-posters/image-runs/${encodeURIComponent(runId)}`,
    { method: 'GET' }
  );
}
