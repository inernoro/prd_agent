import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import type {
  ListDefectTemplatesContract,
  CreateDefectTemplateContract,
  UpdateDefectTemplateContract,
  DeleteDefectTemplateContract,
  ShareDefectTemplateContract,
  ListDefectsContract,
  GetDefectContract,
  CreateDefectContract,
  UpdateDefectContract,
  DeleteDefectContract,
  SubmitDefectContract,
  ProcessDefectContract,
  ResolveDefectContract,
  RejectDefectContract,
  CloseDefectContract,
  ReopenDefectContract,
  GetDefectMessagesContract,
  SendDefectMessageContract,
  AddDefectAttachmentContract,
  DeleteDefectAttachmentContract,
  GetDefectStatsContract,
  GetDefectUsersContract,
  DefectTemplate,
  DefectReport,
  DefectMessage,
  DefectAttachment,
  DefectStats,
  DefectUser,
} from '../contracts/defectAgent';

// ========== Templates ==========

export const listDefectTemplatesReal: ListDefectTemplatesContract = async () => {
  return await apiRequest<{ items: DefectTemplate[] }>(api.defectAgent.templates.list(), {
    method: 'GET',
  });
};

export const createDefectTemplateReal: CreateDefectTemplateContract = async (input) => {
  return await apiRequest<{ template: DefectTemplate }>(api.defectAgent.templates.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateDefectTemplateReal: UpdateDefectTemplateContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ template: DefectTemplate }>(
    api.defectAgent.templates.byId(encodeURIComponent(id)),
    {
      method: 'PUT',
      body: data,
    }
  );
};

export const deleteDefectTemplateReal: DeleteDefectTemplateContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.defectAgent.templates.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const shareDefectTemplateReal: ShareDefectTemplateContract = async (input) => {
  return await apiRequest<{ shared: boolean }>(
    api.defectAgent.templates.share(encodeURIComponent(input.id)),
    {
      method: 'POST',
      body: { targetUserIds: input.targetUserIds },
    }
  );
};

// ========== Defects ==========

export const listDefectsReal: ListDefectsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.filter) qs.set('filter', input.filter);
  if (input?.status) qs.set('status', input.status);
  if (input?.limit) qs.set('limit', String(input.limit));
  if (input?.offset) qs.set('offset', String(input.offset));
  const q = qs.toString();
  return await apiRequest<{ items: DefectReport[]; total: number }>(
    `${api.defectAgent.defects.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getDefectReal: GetDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.byId(encodeURIComponent(input.id)),
    { method: 'GET' }
  );
};

export const createDefectReal: CreateDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(api.defectAgent.defects.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateDefectReal: UpdateDefectContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.byId(encodeURIComponent(id)),
    {
      method: 'PUT',
      body: data,
    }
  );
};

export const deleteDefectReal: DeleteDefectContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.defectAgent.defects.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

// ========== Status Operations ==========

export const submitDefectReal: SubmitDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.submit(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const processDefectReal: ProcessDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.process(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const resolveDefectReal: ResolveDefectContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.resolve(encodeURIComponent(id)),
    {
      method: 'POST',
      body: data,
    }
  );
};

export const rejectDefectReal: RejectDefectContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.reject(encodeURIComponent(id)),
    {
      method: 'POST',
      body: data,
    }
  );
};

export const closeDefectReal: CloseDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.close(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const reopenDefectReal: ReopenDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.reopen(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

// ========== Messages ==========

export const getDefectMessagesReal: GetDefectMessagesContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.afterSeq !== undefined) qs.set('afterSeq', String(input.afterSeq));
  const q = qs.toString();
  return await apiRequest<{ items: DefectMessage[] }>(
    `${api.defectAgent.defects.messages(encodeURIComponent(input.id))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const sendDefectMessageReal: SendDefectMessageContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ message: DefectMessage }>(
    api.defectAgent.defects.messages(encodeURIComponent(id)),
    {
      method: 'POST',
      body: data,
    }
  );
};

// ========== Attachments ==========

export const addDefectAttachmentReal: AddDefectAttachmentContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.defectAgent.defects.attachments(encodeURIComponent(input.id))}`
    : api.defectAgent.defects.attachments(encodeURIComponent(input.id));

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<{ attachment: DefectAttachment }>;
  } catch {
    return {
      success: false,
      data: null,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    } as ApiResponse<{ attachment: DefectAttachment }>;
  }
};

export const deleteDefectAttachmentReal: DeleteDefectAttachmentContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.defectAgent.defects.attachment(encodeURIComponent(input.id), encodeURIComponent(input.attachmentId)),
    { method: 'DELETE' }
  );
};

// ========== Stats & Users ==========

export const getDefectStatsReal: GetDefectStatsContract = async () => {
  return await apiRequest<DefectStats>(api.defectAgent.stats(), { method: 'GET' });
};

export const getDefectUsersReal: GetDefectUsersContract = async () => {
  return await apiRequest<{ items: DefectUser[] }>(api.defectAgent.users(), { method: 'GET' });
};
