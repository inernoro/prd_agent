import { apiRequest } from '@/services/real/apiClient';

// ============ Types（与后端 WeeklyPosterController DTO 对齐） ============

export type WeeklyPosterStatus = 'draft' | 'published' | 'archived';

export interface WeeklyPosterPage {
  /** 页码,从 0 开始 */
  order: number;
  title: string;
  /** 正文,支持 markdown 或纯文本(换行自动 break) */
  body: string;
  /** 配图提示词 */
  imagePrompt: string;
  /** 配图 URL,空值走渐变兜底 */
  imageUrl?: string | null;
  /** 卡片主色调,空值走默认紫 */
  accentColor?: string | null;
}

export interface WeeklyPoster {
  id: string;
  /** ISO 周标识 "2026-W17" */
  weekKey: string;
  title: string;
  subtitle?: string | null;
  status: WeeklyPosterStatus;
  pages: WeeklyPosterPage[];
  ctaText: string;
  ctaUrl: string;
  publishedAt?: string | null;
  updatedAt: string;
}

export interface WeeklyPosterListView {
  total: number;
  page: number;
  pageSize: number;
  items: WeeklyPoster[];
}

export interface WeeklyPosterUpsertInput {
  weekKey?: string;
  title?: string;
  subtitle?: string | null;
  pages?: WeeklyPosterPage[];
  ctaText?: string;
  ctaUrl?: string;
}

// ============ API Calls ============

/**
 * 主页拉取当前待展示的海报(最新一篇 published)。
 * 无可用海报时返回 null。
 */
export async function getCurrentWeeklyPoster() {
  return await apiRequest<WeeklyPoster | null>('/api/weekly-posters/current');
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
