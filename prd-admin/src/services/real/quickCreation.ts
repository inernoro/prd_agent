import { apiDownload, apiRequest, resolveApiUrl } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';
import { connectSse } from '@/lib/useSseStream';
import { fail, type ApiResponse } from '@/types/api';
import type { AssetScope, CreateRunInput, DurationChoice, QcAsset, QcAttachment, QcBriefContext, QcBriefEvent, QcBriefSession, QcEstimate, QcPlayBundle, QcRun, QcTemplate, QcTemplateCategory, QcTemplateSource, QcWork } from '@/pages/quick-creation-agent/types';

/**
 * 快速创作接口。生成在服务端排队与执行（Run/Worker），离开页面不取消；页面按任务编号恢复。
 * 统一走 apiRequest，响应以 success 判断；附件上传是 FormData，按约定直接 fetch。
 */
const base = '/api/quick-creation';

export function listQuickCreationTemplates() {
  /* 风格库目录：分类、风格（含海报地址与风格说明位置）和来源授权，由服务端维护 */
  return apiRequest<{ items: QcTemplate[]; categories: QcTemplateCategory[]; source: QcTemplateSource; browserFilm?: boolean }>(`${base}/templates`);
}

export function listQuickCreationWorks() {
  return apiRequest<{ items: QcWork[]; total: number }>(`${base}/works`);
}

/* 产物：已生成的成品，按「我的 / 团队」取；用于创作时回看与复用风格 */
export function listQuickCreationAssets(scope: AssetScope) {
  return apiRequest<{ items: QcAsset[]; total: number }>(`${base}/assets?scope=${scope}`);
}

export function getQuickCreationRun(runId: string, signal?: AbortSignal) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}`, { signal });
}

export function estimateQuickCreation(attachmentIds: string[], duration: DurationChoice, signal?: AbortSignal) {
  return apiRequest<QcEstimate>(`${base}/estimate`, { method: 'POST', body: { kind: 'video', attachmentIds, duration }, signal });
}

export function approveQuickCreationTrial(runId: string) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}/trial/approve`, {
    method: 'POST', body: {}, headers: { 'Idempotency-Key': `qc-trial-${runId}` },
  });
}

export async function readQuickCreationBundle(runId: string) {
  const result = await apiDownload(`${base}/runs/${encodeURIComponent(runId)}/film-bundle`, 'film-bundle.json');
  if (result.contentType.split(';')[0] !== 'application/json') throw new Error('影片播放包暂未就绪');
  return await result.blob.text().then(text => JSON.parse(text) as QcPlayBundle);
}

type CloudFilmExport = { status: 'none' | 'queued' | 'running' | 'failed' | 'done'; ahead: number; estimatedMinutes?: number; error?: string; downloadAvailable: boolean };

export function getCloudFilmExport(runId: string, signal?: AbortSignal) {
  return apiRequest<CloudFilmExport>(`${base}/runs/${encodeURIComponent(runId)}/export`, { signal });
}

export function queueCloudFilmExport(runId: string) {
  return apiRequest<CloudFilmExport>(`${base}/runs/${encodeURIComponent(runId)}/export`, { method: 'POST', body: {} });
}

export function downloadCloudFilmExport(runId: string, title: string) {
  return apiDownload(`${base}/runs/${encodeURIComponent(runId)}/export/file`, `${title}.mp4`);
}

export async function readQuickCreationPlayer(runId: string) {
  const result = await apiDownload(`${base}/runs/${encodeURIComponent(runId)}/film-bundle?player=true`, 'player.html');
  if (result.contentType.split(';')[0] !== 'text/html') throw new Error('影片播放器暂未就绪');
  return await result.blob.text();
}

export function createQuickCreationRun(input: CreateRunInput, filmComparison?: string) {
  const headers = input.briefId ? { 'Idempotency-Key': `${input.briefId}-${input.briefRevision}` } : undefined;
  const query = filmComparison ? `?filmComparison=${encodeURIComponent(filmComparison)}` : '';
  return apiRequest<QcRun>(`${base}/runs${query}`, { method: 'POST', body: input, headers });
}

export function getQuickCreationBrief(id: string, signal?: AbortSignal) {
  return apiRequest<QcBriefSession>(`${base}/brief/${encodeURIComponent(id)}`, { signal });
}

export function syncQuickCreationBrief(id: string, context: QcBriefContext) {
  return apiRequest<QcBriefSession>(`${base}/brief/${encodeURIComponent(id)}/context`, { method: 'POST', body: context });
}

export function streamQuickCreationBrief(id: string, body: {
  turnId: string; mode: 'message' | 'script'; text: string; context: QcBriefContext;
}, signal: AbortSignal, onEvent: (event: QcBriefEvent) => void) {
  return connectSse({
    url: resolveApiUrl(`${base}/brief/${encodeURIComponent(id)}/messages`), method: 'POST', body, signal,
    // A retry is a new transport attempt for the same durable conversation turn.
    headers: { 'Idempotency-Key': crypto.randomUUID(), 'X-Client': 'admin' },
    onEvent(event) {
      if (event.event && event.data) onEvent({ name: event.event, ...JSON.parse(event.data) } as QcBriefEvent);
    },
  });
}

/** 按任务当前支持的恢复动作提交，原稿与要求保存在原任务中。 */
export function retryQuickCreationRun(runId: string, input: { action: 'retry-unit' | 'retry-step' | 'skip-unit' | 'requeue' | 'resume'; unitIndex?: number }) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST', body: input });
}

/** 发布到网页托管；重试只上传，不会重新生成 */
export function publishQuickCreationRun(runId: string) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}/publish`, { method: 'POST', body: {} });
}

export function addKnowledgeAttachment(entryId: string, storeId?: string) {
  return apiRequest<QcAttachment>(`${base}/attachments/knowledge`, { method: 'POST', body: { entryId, storeId } });
}

export async function readQuickCreationFilm(runId: string, subtitleFreePreview = false) {
  const file = await apiDownload(`/api/design-artifacts/runs/${encodeURIComponent(runId)}/film.mp4${subtitleFreePreview ? '?preview=true' : ''}`, 'film.mp4');
  if (file.contentType.split(';')[0] !== 'video/mp4') {
    throw new Error('成片暂时无法读取');
  }
  return file.blob;
}

export async function readQuickCreationImage(attachmentId: string) {
  const result = await apiDownload(`${base}/attachments/${encodeURIComponent(attachmentId)}/image`, 'reference-image');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.contentType.split(';')[0]))
    throw new Error('图片暂时无法读取');
  return result.blob;
}

export function readQuickCreationPage(siteId: string) {
  return apiRequest<{ siteUrl: string; html: string }>(`/api/web-pages/${encodeURIComponent(siteId)}/content`);
}

export function retryAttachmentRead(attachmentId: string) {
  return apiRequest<QcAttachment>(`${base}/attachments/${encodeURIComponent(attachmentId)}/read`, { method: 'POST', body: {} });
}

/** 粘贴的长正文作为一份稿件附件保存，输入框只留给「要求」 */
export function addTextAttachment(input: { name: string; text: string }) {
  return apiRequest<QcAttachment>(`${base}/attachments/text`, { method: 'POST', body: input });
}

export async function uploadQuickCreationAttachment(file: File): Promise<ApiResponse<QcAttachment>> {
  const token = useAuthStore.getState().token;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(resolveApiUrl(`${base}/attachments`), {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
      credentials: 'include',
    });
    return (await res.json()) as ApiResponse<QcAttachment>;
  } catch {
    return fail('NETWORK_ERROR', '上传没有完成，请检查网络后重试');
  }
}
