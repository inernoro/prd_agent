import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';
import { fail, type ApiResponse } from '@/types/api';
import type { AssetScope, BriefContext, CreateRunInput, DurationChoice, OutputKind, QcBriefSession, QcAsset, QcAttachment, QcEstimate, QcRun, QcTemplate, QcTemplateCategory, QcTemplateSource, QcWork } from '@/pages/quick-creation-agent/types';

/**
 * 快速创作接口。生成在服务端排队与执行（Run/Worker），离开页面不取消；页面按任务编号恢复。
 * 统一走 apiRequest，响应以 success 判断；附件上传是 FormData，按约定直接 fetch。
 */
const base = '/api/quick-creation';

export function listQuickCreationTemplates() {
  /* 风格库目录：分类、风格（含海报地址与风格说明位置）和来源授权，由服务端维护 */
  return apiRequest<{ items: QcTemplate[]; categories: QcTemplateCategory[]; source: QcTemplateSource }>(`${base}/templates`);
}

export function listQuickCreationWorks() {
  return apiRequest<{ items: QcWork[]; total: number }>(`${base}/works`);
}

/* 对话起稿：正式实现走 SSE 流式返回（useSseStream），助手消息逐字出现并带上网关返回的模型；原型一次返回整条，由页面逐字显示 */
export function sendBriefMessage(input: { sessionId?: string; text: string; context: BriefContext }) {
  return apiRequest<QcBriefSession>(`${base}/brief/messages`, { method: 'POST', body: input });
}

/** 输入框里的选择变了（产出、风格、资料），只更新简报，不产生对话 */
export function updateBriefContext(input: { sessionId?: string; context: BriefContext }) {
  return apiRequest<QcBriefSession>(`${base}/brief/context`, { method: 'POST', body: input });
}

/** 开工前先出分镜脚本（约一两分钟），确认后再正式排队；adjust 用于「短一点 / 长一点」重写这版脚本 */
export function requestBriefScript(sessionId: string, context: BriefContext, adjust?: 'shorter' | 'longer') {
  return apiRequest<QcBriefSession>(`${base}/brief/${encodeURIComponent(sessionId)}/script`, { method: 'POST', body: { context, ...(adjust ? { adjust } : {}) } });
}

/** 开工前的时长与耗时预估：按产出、资料与时长选择算出目标时长、幕数和预计生成耗时 */
export function estimateQuickCreation(input: { kind: OutputKind; attachmentIds: string[]; duration: DurationChoice; briefId?: string }) {
  return apiRequest<QcEstimate>(`${base}/estimate`, { method: 'POST', body: input });
}

/** 试看满意：从断点接着做完，试看的两幕沿用 */
export function approveQuickCreationTrial(runId: string) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}/trial/approve`, { method: 'POST', body: {} });
}

/** 浏览器不能本机合成时，请服务器代为导出视频文件（排队执行，占服务器资源，只作兜底） */
export function requestServerExport(runId: string) {
  return apiRequest<{ position: number; etaMin: number }>(`${base}/runs/${encodeURIComponent(runId)}/server-export`, { method: 'POST', body: {} });
}

/* 产物：已生成的成品，按「我的 / 团队」取；用于创作时回看与复用风格 */
export function listQuickCreationAssets(scope: AssetScope) {
  return apiRequest<{ items: QcAsset[]; total: number }>(`${base}/assets?scope=${scope}`);
}

export function getQuickCreationRun(runId: string) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}`);
}

export function createQuickCreationRun(input: CreateRunInput) {
  return apiRequest<QcRun>(`${base}/runs`, { method: 'POST', body: input });
}

/** 只重做失败的那一步或那一幕，已完成的部分保留 */
export function retryQuickCreationRun(runId: string, input: { action: 'retry-unit' | 'retry-step' | 'skip-unit' | 'requeue'; unitIndex?: number }) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST', body: input });
}

/** 发布到网页托管；重试只上传，不会重新生成 */
export function publishQuickCreationRun(runId: string) {
  return apiRequest<QcRun>(`${base}/runs/${encodeURIComponent(runId)}/publish`, { method: 'POST', body: {} });
}

export function addKnowledgeAttachment(entryId: string) {
  return apiRequest<QcAttachment>(`${base}/attachments/knowledge`, { method: 'POST', body: { entryId } });
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
    const res = await fetch(`${base}/attachments`, {
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
