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
  PolishDefectContract,
  AnalyzeDefectImageContract,
  ListDeletedDefectsContract,
  RestoreDefectContract,
  PermanentDeleteDefectContract,
  ListDefectFoldersContract,
  CreateDefectFolderContract,
  UpdateDefectFolderContract,
  DeleteDefectFolderContract,
  MoveDefectToFolderContract,
  BatchMoveDefectsContract,
  PreviewApiLogsContract,
  VerifyPassContract,
  VerifyFailContract,
  ListDefectProjectsContract,
  CreateDefectProjectContract,
  UpdateDefectProjectContract,
  ArchiveDefectProjectContract,
  ListDefectTeamsContract,
  GetDefectStatsOverviewContract,
  GetDefectStatsTrendContract,
  GetDefectStatsByUserContract,
  ListDefectWebhooksContract,
  CreateDefectWebhookContract,
  UpdateDefectWebhookContract,
  DeleteDefectWebhookContract,
  DefectTemplate,
  DefectReport,
  DefectMessage,
  DefectAttachment,
  DefectStats,
  DefectUser,
  DefectFolder,
  DefectProject,
  DefectTeam,
  DefectStatsOverview,
  DefectWebhookConfig,
  UserStatItem,
  ApiLogPreviewItem,
  DefectShareLink,
  DefectFixReport,
  DefectFixReportItem,
  CreateDefectShareContract,
  ListDefectSharesContract,
  RevokeDefectShareContract,
  ListDefectFixReportsContract,
  AcceptDefectFixItemContract,
  RejectDefectFixItemContract,
  CreateBatchShareContract,
  GetShareScoresContract,
  DefectAiScoreItem,
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
  if (input?.folderId) qs.set('folderId', input.folderId);
  if (input?.projectId) qs.set('projectId', input.projectId);
  if (input?.teamId) qs.set('teamId', input.teamId);
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
  return await apiRequest<{ messages: DefectMessage[] }>(
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
  if (input.description) fd.append('description', input.description);

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

export const getDefectStatsReal: GetDefectStatsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.projectId) qs.set('projectId', input.projectId);
  if (input?.teamId) qs.set('teamId', input.teamId);
  const q = qs.toString();
  return await apiRequest<DefectStats>(
    `${api.defectAgent.stats()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getDefectUsersReal: GetDefectUsersContract = async () => {
  return await apiRequest<{ items: DefectUser[] }>(api.defectAgent.users(), { method: 'GET' });
};

// ========== AI ==========

export const polishDefectReal: PolishDefectContract = async (input) => {
  return await apiRequest<{ content: string }>(api.defectAgent.polish(), {
    method: 'POST',
    body: input,
  });
};

export const analyzeDefectImageReal: AnalyzeDefectImageContract = async (input) => {
  return await apiRequest<{ description: string }>(api.defectAgent.analyzeImage(), {
    method: 'POST',
    body: input,
  });
};

// ========== Trash (回收站) ==========

export const listDeletedDefectsReal: ListDeletedDefectsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.limit) qs.set('pageSize', String(input.limit));
  if (input?.offset) qs.set('page', String(Math.floor((input.offset || 0) / (input.limit || 20)) + 1));
  const q = qs.toString();
  return await apiRequest<{ items: DefectReport[]; total: number }>(
    `${api.defectAgent.trash()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const restoreDefectReal: RestoreDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.restore(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const permanentDeleteDefectReal: PermanentDeleteDefectContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.defectAgent.defects.permanent(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

// ========== Folders (文件夹) ==========

export const listDefectFoldersReal: ListDefectFoldersContract = async () => {
  return await apiRequest<{ items: DefectFolder[] }>(api.defectAgent.folders.list(), {
    method: 'GET',
  });
};

export const createDefectFolderReal: CreateDefectFolderContract = async (input) => {
  return await apiRequest<{ folder: DefectFolder }>(api.defectAgent.folders.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateDefectFolderReal: UpdateDefectFolderContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ folder: DefectFolder }>(
    api.defectAgent.folders.byId(encodeURIComponent(id)),
    {
      method: 'PUT',
      body: data,
    }
  );
};

export const deleteDefectFolderReal: DeleteDefectFolderContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.defectAgent.folders.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const moveDefectToFolderReal: MoveDefectToFolderContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.move(encodeURIComponent(id)),
    {
      method: 'POST',
      body: data,
    }
  );
};

export const batchMoveDefectsReal: BatchMoveDefectsContract = async (input) => {
  return await apiRequest<{ movedCount: number }>(api.defectAgent.defects.batchMove(), {
    method: 'POST',
    body: input,
  });
};

// ========== 验收 ==========

export const verifyPassReal: VerifyPassContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.verifyPass(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const verifyFailReal: VerifyFailContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ defect: DefectReport }>(
    api.defectAgent.defects.verifyFail(encodeURIComponent(id)),
    { method: 'POST', body: data }
  );
};

// ========== 项目管理 ==========

export const listDefectProjectsReal: ListDefectProjectsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.keyword) qs.set('keyword', input.keyword);
  const q = qs.toString();
  return await apiRequest<{ items: DefectProject[] }>(
    `${api.defectAgent.projects.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const createDefectProjectReal: CreateDefectProjectContract = async (input) => {
  return await apiRequest<{ project: DefectProject }>(api.defectAgent.projects.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateDefectProjectReal: UpdateDefectProjectContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ project: DefectProject }>(
    api.defectAgent.projects.byId(encodeURIComponent(id)),
    { method: 'PUT', body: data }
  );
};

export const archiveDefectProjectReal: ArchiveDefectProjectContract = async (input) => {
  return await apiRequest<{ archived: boolean }>(
    api.defectAgent.projects.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

// ========== 团队查询 ==========

export const listDefectTeamsReal: ListDefectTeamsContract = async () => {
  return await apiRequest<{ items: DefectTeam[] }>(api.defectAgent.teams(), { method: 'GET' });
};

// ========== 统计看板 ==========

export const getDefectStatsOverviewReal: GetDefectStatsOverviewContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.projectId) qs.set('projectId', input.projectId);
  if (input?.teamId) qs.set('teamId', input.teamId);
  if (input?.from) qs.set('from', input.from);
  if (input?.to) qs.set('to', input.to);
  const q = qs.toString();
  return await apiRequest<DefectStatsOverview>(
    `${api.defectAgent.statsOverview()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getDefectStatsTrendReal: GetDefectStatsTrendContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.projectId) qs.set('projectId', input.projectId);
  if (input?.teamId) qs.set('teamId', input.teamId);
  if (input?.from) qs.set('from', input.from);
  if (input?.to) qs.set('to', input.to);
  if (input?.period) qs.set('period', input.period);
  const q = qs.toString();
  return await apiRequest<{ created: Record<string, number>; closed: Record<string, number>; period: string }>(
    `${api.defectAgent.statsTrend()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getDefectStatsByUserReal: GetDefectStatsByUserContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.projectId) qs.set('projectId', input.projectId);
  if (input?.teamId) qs.set('teamId', input.teamId);
  if (input?.from) qs.set('from', input.from);
  if (input?.to) qs.set('to', input.to);
  const q = qs.toString();
  return await apiRequest<{ byAssignee: UserStatItem[]; byReporter: UserStatItem[] }>(
    `${api.defectAgent.statsByUser()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

// ========== Webhook 配置 ==========

export const listDefectWebhooksReal: ListDefectWebhooksContract = async () => {
  return await apiRequest<{ items: DefectWebhookConfig[] }>(api.defectAgent.webhooks.list(), { method: 'GET' });
};

export const createDefectWebhookReal: CreateDefectWebhookContract = async (input) => {
  return await apiRequest<{ webhook: DefectWebhookConfig }>(api.defectAgent.webhooks.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateDefectWebhookReal: UpdateDefectWebhookContract = async (input) => {
  const { id, ...data } = input;
  return await apiRequest<{ webhook: DefectWebhookConfig }>(
    api.defectAgent.webhooks.byId(encodeURIComponent(id)),
    { method: 'PUT', body: data }
  );
};

export const deleteDefectWebhookReal: DeleteDefectWebhookContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.defectAgent.webhooks.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

// ========== 日志预览 ==========

export const previewApiLogsReal: PreviewApiLogsContract = async () => {
  return await apiRequest<{ totalCount: number; errorCount: number; items: ApiLogPreviewItem[] }>(
    api.defectAgent.logs.preview(),
    { method: 'GET' }
  );
};

// ========== 分享管理 ==========

export const createDefectShareReal: CreateDefectShareContract = async (input) => {
  return await apiRequest<{ shareLink: DefectShareLink; shareUrl: string }>(
    api.defectAgent.shares.list(),
    { method: 'POST', body: input }
  );
};

export const listDefectSharesReal: ListDefectSharesContract = async () => {
  return await apiRequest<{ items: DefectShareLink[] }>(
    api.defectAgent.shares.list(),
    { method: 'GET' }
  );
};

export const revokeDefectShareReal: RevokeDefectShareContract = async (input) => {
  return await apiRequest<{ revoked: boolean }>(
    api.defectAgent.shares.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const listDefectFixReportsReal: ListDefectFixReportsContract = async (input) => {
  return await apiRequest<{ items: DefectFixReport[] }>(
    api.defectAgent.shares.reports(encodeURIComponent(input.shareId)),
    { method: 'GET' }
  );
};

export const acceptDefectFixItemReal: AcceptDefectFixItemContract = async (input) => {
  const { reportId, defectId, ...body } = input;
  return await apiRequest<{ item: DefectFixReportItem; defect?: DefectReport }>(
    api.defectAgent.shares.acceptItem(encodeURIComponent(reportId), encodeURIComponent(defectId)),
    { method: 'POST', body }
  );
};

export const rejectDefectFixItemReal: RejectDefectFixItemContract = async (input) => {
  const { reportId, defectId, ...body } = input;
  return await apiRequest<{ item: DefectFixReportItem }>(
    api.defectAgent.shares.rejectItem(encodeURIComponent(reportId), encodeURIComponent(defectId)),
    { method: 'POST', body }
  );
};

export const createBatchShareReal: CreateBatchShareContract = async (input) => {
  return await apiRequest<{ shareLink: DefectShareLink; shareUrl: string }>(
    api.defectAgent.shares.batch(),
    { method: 'POST', body: input }
  );
};

export const getShareScoresReal: GetShareScoresContract = async (input) => {
  return await apiRequest<{ aiScoreStatus: string; scores: DefectAiScoreItem[] }>(
    api.defectAgent.shares.scores(encodeURIComponent(input.shareId)),
    { method: 'GET' }
  );
};
