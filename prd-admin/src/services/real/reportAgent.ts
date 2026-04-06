import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import { useAuthStore } from '@/stores/authStore';
import type {
  ListReportTeamsContract,
  GetReportTeamContract,
  CreateReportTeamContract,
  UpdateReportTeamContract,
  DeleteReportTeamContract,
  LeaveReportTeamContract,
  AddReportTeamMemberContract,
  RemoveReportTeamMemberContract,
  UpdateReportTeamMemberContract,
  ListReportUsersContract,
  ListReportTemplatesContract,
  GetReportTemplateContract,
  CreateReportTemplateContract,
  UpdateReportTemplateContract,
  DeleteReportTemplateContract,
  ListWeeklyReportsContract,
  GetWeeklyReportContract,
  CreateWeeklyReportContract,
  UpdateWeeklyReportContract,
  UploadReportRichTextImageContract,
  DeleteWeeklyReportContract,
  SubmitWeeklyReportContract,
  ReviewWeeklyReportContract,
  ReturnWeeklyReportContract,
  GetTeamDashboardContract,
  SaveDailyLogContract,
  ListDailyLogsContract,
  GetDailyLogContract,
  DeleteDailyLogContract,
  ListDataSourcesContract,
  CreateDataSourceContract,
  UpdateDataSourceContract,
  DeleteDataSourceContract,
  TestDataSourceContract,
  SyncDataSourceContract,
  ListDataSourceCommitsContract,
  GenerateReportContract,
  GetCollectedActivityContract,
  ListCommentsContract,
  CreateCommentContract,
  DeleteCommentContract,
  ListReportLikesContract,
  LikeReportContract,
  UnlikeReportContract,
  RecordReportViewContract,
  GetReportViewsSummaryContract,
  GetPlanComparisonContract,
  GenerateTeamSummaryContract,
  GetTeamSummaryContract,
  GetTeamSummaryViewContract,
  GetTeamReportsViewContract,
  GetPersonalTrendsContract,
  GetTeamTrendsContract,
  MarkVacationContract,
  CancelVacationContract,
  ListMyAiSourcesContract,
  UpdateMyAiSourceContract,
  GetMyAiReportPromptContract,
  UpdateMyAiReportPromptContract,
  ResetMyAiReportPromptContract,
  GetTeamAiSummaryPromptContract,
  UpdateTeamAiSummaryPromptContract,
  ResetTeamAiSummaryPromptContract,
  GetMyDailyLogTagsContract,
  UpdateMyDailyLogTagsContract,
  ListPersonalSourcesContract,
  CreatePersonalSourceContract,
  UpdatePersonalSourceContract,
  DeletePersonalSourceContract,
  TestPersonalSourceContract,
  SyncPersonalSourceContract,
  GetPersonalStatsContract,
  GetTeamWorkflowContract,
  RunTeamWorkflowContract,
  UpdateIdentityMappingsContract,
  SeedSystemTemplatesContract,
  PersonalTrendItem,
  TeamTrendItem,
  ReportAiPromptSettings,
  DailyLog,
  ReportDataSource,
  ReportCommit,
  CollectedActivity,
  ReportTeam,
  ReportTeamMember,
  ReportTemplate,
  WeeklyReport,
  ReportRichTextImageUploadData,
  ReportUser,
  TeamDashboardData,
  ReportComment,
  ReportLikeSummary,
  ReportViewSummary,
  PlanComparison,
  TeamSummary,
  TeamSummaryViewData,
  TeamReportsViewData,
  ReportAiSource,
  PersonalSource,
  PersonalStats,
  TeamWorkflowInfo,
  ReportWebhookConfig,
  ListWebhooksContract,
  CreateWebhookContract,
  UpdateWebhookContract,
  DeleteWebhookContract,
  TestWebhookContract,
} from '../contracts/reportAgent';

type RefreshOkData = { accessToken: string; refreshToken: string; sessionKey: string };

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

function isRefreshOkData(data: unknown): data is RefreshOkData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.accessToken === 'string'
    && typeof obj.refreshToken === 'string'
    && typeof obj.sessionKey === 'string';
}

async function tryRefreshAdminTokenForUpload(): Promise<boolean> {
  const authStore = useAuthStore.getState();
  const token = authStore.token;
  const refreshToken = authStore.refreshToken;
  const sessionKey = authStore.sessionKey;
  const userId = authStore.user?.userId;

  if (!authStore.isAuthenticated || !token || !refreshToken || !sessionKey || !userId) return false;

  const url = joinUrl(getApiBaseUrl(), api.auth.refresh());
  const body = JSON.stringify({
    refreshToken,
    userId,
    clientType: 'admin',
    sessionKey,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) as ApiResponse<RefreshOkData> : null;
    if (!res.ok || !parsed?.success || !isRefreshOkData(parsed.data)) return false;
    authStore.setTokens(parsed.data.accessToken, parsed.data.refreshToken, parsed.data.sessionKey);
    return true;
  } catch {
    return false;
  }
}

// ========== Teams ==========

export const listReportTeamsReal: ListReportTeamsContract = async () => {
  return await apiRequest<{ items: ReportTeam[] }>(api.reportAgent.teams.list(), { method: 'GET' });
};

export const getReportTeamReal: GetReportTeamContract = async (input) => {
  return await apiRequest<{ team: ReportTeam; members: ReportTeamMember[] }>(
    api.reportAgent.teams.byId(encodeURIComponent(input.id)),
    { method: 'GET' }
  );
};

export const createReportTeamReal: CreateReportTeamContract = async (input) => {
  return await apiRequest<{ team: ReportTeam }>(api.reportAgent.teams.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateReportTeamReal: UpdateReportTeamContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest<{ team: ReportTeam }>(
    api.reportAgent.teams.byId(encodeURIComponent(id)),
    { method: 'PUT', body }
  );
};

export const deleteReportTeamReal: DeleteReportTeamContract = async (input) => {
  return await apiRequest<object>(
    api.reportAgent.teams.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const leaveReportTeamReal: LeaveReportTeamContract = async (input) => {
  return await apiRequest<{ left: boolean }>(
    api.reportAgent.teams.leave(encodeURIComponent(input.teamId)),
    { method: 'POST' }
  );
};

// ========== Team Members ==========

export const addReportTeamMemberReal: AddReportTeamMemberContract = async (input) => {
  const { teamId, ...body } = input;
  return await apiRequest<{ member: ReportTeamMember }>(
    api.reportAgent.teams.members(encodeURIComponent(teamId)),
    { method: 'POST', body }
  );
};

export const removeReportTeamMemberReal: RemoveReportTeamMemberContract = async (input) => {
  return await apiRequest<object>(
    api.reportAgent.teams.member(encodeURIComponent(input.teamId), encodeURIComponent(input.userId)),
    { method: 'DELETE' }
  );
};

export const updateReportTeamMemberReal: UpdateReportTeamMemberContract = async (input) => {
  const { teamId, userId, ...body } = input;
  return await apiRequest<{ member: ReportTeamMember }>(
    api.reportAgent.teams.member(encodeURIComponent(teamId), encodeURIComponent(userId)),
    { method: 'PUT', body }
  );
};

// ========== Users ==========

export const listReportUsersReal: ListReportUsersContract = async () => {
  return await apiRequest<{ items: ReportUser[] }>(api.reportAgent.users(), { method: 'GET' });
};

// ========== Templates ==========

export const listReportTemplatesReal: ListReportTemplatesContract = async () => {
  return await apiRequest<{ items: ReportTemplate[] }>(api.reportAgent.templates.list(), { method: 'GET' });
};

export const getReportTemplateReal: GetReportTemplateContract = async (input) => {
  return await apiRequest<{ template: ReportTemplate }>(
    api.reportAgent.templates.byId(encodeURIComponent(input.id)),
    { method: 'GET' }
  );
};

export const createReportTemplateReal: CreateReportTemplateContract = async (input) => {
  return await apiRequest<{ template: ReportTemplate }>(api.reportAgent.templates.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateReportTemplateReal: UpdateReportTemplateContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest<{ template: ReportTemplate }>(
    api.reportAgent.templates.byId(encodeURIComponent(id)),
    { method: 'PUT', body }
  );
};

export const deleteReportTemplateReal: DeleteReportTemplateContract = async (input) => {
  return await apiRequest<object>(
    api.reportAgent.templates.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

// ========== Reports ==========

export const listWeeklyReportsReal: ListWeeklyReportsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.scope) qs.set('scope', input.scope);
  if (input?.teamId) qs.set('teamId', input.teamId);
  if (input?.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input?.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<{ items: WeeklyReport[] }>(
    `${api.reportAgent.reports.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getWeeklyReportReal: GetWeeklyReportContract = async (input) => {
  return await apiRequest<{ report: WeeklyReport }>(
    api.reportAgent.reports.byId(encodeURIComponent(input.id)),
    { method: 'GET' }
  );
};

export const createWeeklyReportReal: CreateWeeklyReportContract = async (input) => {
  return await apiRequest<{ report: WeeklyReport; aiGenerationError?: string }>(api.reportAgent.reports.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateWeeklyReportReal: UpdateWeeklyReportContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest<{ report: WeeklyReport }>(
    api.reportAgent.reports.byId(encodeURIComponent(id)),
    { method: 'PUT', body }
  );
};

export const uploadReportRichTextImageReal: UploadReportRichTextImageContract = async (input) => {
  const buildHeaders = (token: string | null | undefined) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  };
  const createFormData = () => {
    const fd = new FormData();
    fd.append('file', input.file);
    return fd;
  };

  const parseResponse = async (res: Response): Promise<ApiResponse<ReportRichTextImageUploadData>> => {
    const text = await res.text();
    try {
      return JSON.parse(text) as ApiResponse<ReportRichTextImageUploadData>;
    } catch {
      return { success: false, error: { code: 'PARSE_ERROR', message: text || '上传失败' } } as ApiResponse<ReportRichTextImageUploadData>;
    }
  };

  const rawBase = getApiBaseUrl();
  const path = api.reportAgent.reports.richTextImages(encodeURIComponent(input.id));
  const url = rawBase ? `${rawBase}${path}` : path;

  try {
    const firstRes = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(useAuthStore.getState().token),
      body: createFormData(),
    });
    const firstParsed = await parseResponse(firstRes);
    const firstUnauthorized = firstRes.status === 401 || firstParsed.error?.code === 'UNAUTHORIZED';
    if (!firstUnauthorized) return firstParsed;

    const refreshed = await tryRefreshAdminTokenForUpload();
    if (!refreshed) return firstParsed;

    const retryRes = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(useAuthStore.getState().token),
      body: createFormData(),
    });
    return await parseResponse(retryRes);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : '网络错误，上传失败',
      },
    } as ApiResponse<ReportRichTextImageUploadData>;
  }
};

export const deleteWeeklyReportReal: DeleteWeeklyReportContract = async (input) => {
  return await apiRequest<object>(
    api.reportAgent.reports.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const submitWeeklyReportReal: SubmitWeeklyReportContract = async (input) => {
  return await apiRequest<{ report: WeeklyReport }>(
    api.reportAgent.reports.submit(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const reviewWeeklyReportReal: ReviewWeeklyReportContract = async (input) => {
  return await apiRequest<{ report: WeeklyReport }>(
    api.reportAgent.reports.review(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const returnWeeklyReportReal: ReturnWeeklyReportContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest<{ report: WeeklyReport }>(
    api.reportAgent.reports.return(encodeURIComponent(id)),
    { method: 'POST', body }
  );
};

// ========== Dashboard ==========

export const getTeamDashboardReal: GetTeamDashboardContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<TeamDashboardData>(
    `${api.reportAgent.teams.dashboard(encodeURIComponent(input.teamId))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

// ========== Daily Logs ==========

export const saveDailyLogReal: SaveDailyLogContract = async (input) => {
  return await apiRequest<DailyLog>(api.reportAgent.dailyLogs.list(), {
    method: 'POST',
    body: input,
  });
};

export const listDailyLogsReal: ListDailyLogsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.startDate) qs.set('startDate', input.startDate);
  if (input?.endDate) qs.set('endDate', input.endDate);
  const q = qs.toString();
  return await apiRequest<{ items: DailyLog[] }>(
    `${api.reportAgent.dailyLogs.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getDailyLogReal: GetDailyLogContract = async (input) => {
  return await apiRequest<DailyLog>(
    api.reportAgent.dailyLogs.byDate(encodeURIComponent(input.date)),
    { method: 'GET' }
  );
};

export const deleteDailyLogReal: DeleteDailyLogContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.reportAgent.dailyLogs.byDate(encodeURIComponent(input.date)),
    { method: 'DELETE' }
  );
};

// ========== Data Sources ==========

export const listDataSourcesReal: ListDataSourcesContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.teamId) qs.set('teamId', input.teamId);
  const q = qs.toString();
  return await apiRequest<{ items: ReportDataSource[] }>(
    `${api.reportAgent.dataSources.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const createDataSourceReal: CreateDataSourceContract = async (input) => {
  return await apiRequest<{ id: string }>(api.reportAgent.dataSources.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateDataSourceReal: UpdateDataSourceContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest<object>(
    api.reportAgent.dataSources.byId(encodeURIComponent(id)),
    { method: 'PUT', body }
  );
};

export const deleteDataSourceReal: DeleteDataSourceContract = async (input) => {
  return await apiRequest<object>(
    api.reportAgent.dataSources.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const testDataSourceReal: TestDataSourceContract = async (input) => {
  return await apiRequest<{ success: boolean; error?: string }>(
    api.reportAgent.dataSources.test(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const syncDataSourceReal: SyncDataSourceContract = async (input) => {
  return await apiRequest<{ syncedCommits: number; error?: string }>(
    api.reportAgent.dataSources.sync(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const listDataSourceCommitsReal: ListDataSourceCommitsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.since) qs.set('since', input.since);
  if (input.until) qs.set('until', input.until);
  if (input.limit != null) qs.set('limit', String(input.limit));
  const q = qs.toString();
  return await apiRequest<{ items: ReportCommit[] }>(
    `${api.reportAgent.dataSources.commits(encodeURIComponent(input.id))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

// ========== AI Generation ==========

export const generateReportReal: GenerateReportContract = async (input) => {
  return await apiRequest<WeeklyReport>(
    api.reportAgent.reports.generate(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const getCollectedActivityReal: GetCollectedActivityContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input?.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<CollectedActivity>(
    `${api.reportAgent.activity()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

// ========== Phase 3: Comments ==========

export const listCommentsReal: ListCommentsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.sectionIndex != null) qs.set('sectionIndex', String(input.sectionIndex));
  const q = qs.toString();
  return await apiRequest<{ items: ReportComment[] }>(
    `${api.reportAgent.reports.comments(encodeURIComponent(input.reportId))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const createCommentReal: CreateCommentContract = async (input) => {
  const { reportId, ...body } = input;
  return await apiRequest<{ comment: ReportComment }>(
    api.reportAgent.reports.comments(encodeURIComponent(reportId)),
    { method: 'POST', body }
  );
};

export const deleteCommentReal: DeleteCommentContract = async (input) => {
  return await apiRequest<object>(
    api.reportAgent.reports.comment(encodeURIComponent(input.reportId), encodeURIComponent(input.commentId)),
    { method: 'DELETE' }
  );
};

export const listReportLikesReal: ListReportLikesContract = async (input) => {
  return await apiRequest<ReportLikeSummary>(
    api.reportAgent.reports.likes(encodeURIComponent(input.reportId)),
    { method: 'GET' }
  );
};

export const likeReportReal: LikeReportContract = async (input) => {
  return await apiRequest<ReportLikeSummary>(
    api.reportAgent.reports.likes(encodeURIComponent(input.reportId)),
    { method: 'POST' }
  );
};

export const unlikeReportReal: UnlikeReportContract = async (input) => {
  return await apiRequest<ReportLikeSummary>(
    api.reportAgent.reports.likes(encodeURIComponent(input.reportId)),
    { method: 'DELETE' }
  );
};

export const recordReportViewReal: RecordReportViewContract = async (input) => {
  return await apiRequest<{ viewedAt: string }>(
    api.reportAgent.reports.views(encodeURIComponent(input.reportId)),
    { method: 'POST' }
  );
};

export const getReportViewsSummaryReal: GetReportViewsSummaryContract = async (input) => {
  return await apiRequest<ReportViewSummary>(
    api.reportAgent.reports.viewsSummary(encodeURIComponent(input.reportId)),
    { method: 'GET' }
  );
};

// ========== Phase 3: Plan Comparison ==========

export const getPlanComparisonReal: GetPlanComparisonContract = async (input) => {
  return await apiRequest<PlanComparison>(
    api.reportAgent.reports.planComparison(encodeURIComponent(input.reportId)),
    { method: 'GET' }
  );
};

// ========== Phase 3: Team Summary ==========

export const generateTeamSummaryReal: GenerateTeamSummaryContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<{ summary: TeamSummary }>(
    `${api.reportAgent.teams.summaryGenerate(encodeURIComponent(input.teamId))}${q ? `?${q}` : ''}`,
    { method: 'POST' }
  );
};

export const getTeamSummaryReal: GetTeamSummaryContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<{ summary: TeamSummary | null }>(
    `${api.reportAgent.teams.summary(encodeURIComponent(input.teamId))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getTeamSummaryViewReal: GetTeamSummaryViewContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<TeamSummaryViewData>(
    `${api.reportAgent.teams.summaryView(encodeURIComponent(input.teamId))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getTeamReportsViewReal: GetTeamReportsViewContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<TeamReportsViewData>(
    `${api.reportAgent.teams.reportsView(encodeURIComponent(input.teamId))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

// ========== Phase 4: History Trends ==========

export const getPersonalTrendsReal: GetPersonalTrendsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.weeks != null) qs.set('weeks', String(input.weeks));
  const q = qs.toString();
  return await apiRequest<{ items: PersonalTrendItem[]; weeks: number }>(
    `${api.reportAgent.trends.personal()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getTeamTrendsReal: GetTeamTrendsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.weeks != null) qs.set('weeks', String(input.weeks));
  const q = qs.toString();
  return await apiRequest<{ items: TeamTrendItem[]; weeks: number; teamId: string }>(
    `${api.reportAgent.trends.team(encodeURIComponent(input.teamId))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

// ========== Phase 4: Export ==========

export const exportReportMarkdownReal = async (input: { id: string }): Promise<Blob> => {
  const token = sessionStorage.getItem('accessToken');
  const res = await fetch(`${api.reportAgent.reports.byId(encodeURIComponent(input.id))}/export/markdown`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('导出失败');
  return res.blob();
};

export const exportTeamSummaryMarkdownReal = async (input: {
  teamId: string; weekYear?: number; weekNumber?: number;
}): Promise<Blob> => {
  const qs = new URLSearchParams();
  if (input.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  const token = sessionStorage.getItem('accessToken');
  const res = await fetch(
    `${api.reportAgent.teams.summary(encodeURIComponent(input.teamId))}/export/markdown${q ? `?${q}` : ''}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  if (!res.ok) throw new Error('导出失败');
  return res.blob();
};

// ========== Phase 4: Vacation ==========

export const markVacationReal: MarkVacationContract = async (input) => {
  const { teamId, userId, ...body } = input;
  return await apiRequest<{ report: WeeklyReport }>(
    `/api/report-agent/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/vacation`,
    { method: 'POST', body }
  );
};

export const cancelVacationReal: CancelVacationContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<{ deleted: boolean }>(
    `/api/report-agent/teams/${encodeURIComponent(input.teamId)}/members/${encodeURIComponent(input.userId)}/vacation${q ? `?${q}` : ''}`,
    { method: 'DELETE' }
  );
};

// ========== Phase 5/6 v2.0: Personal Sources ==========

export const listMyAiSourcesReal: ListMyAiSourcesContract = async () => {
  return await apiRequest<{ items: ReportAiSource[] }>(api.reportAgent.aiSources.list(), { method: 'GET' });
};

export const updateMyAiSourceReal: UpdateMyAiSourceContract = async (input) => {
  return await apiRequest<{ source: { key: string; enabled: boolean } }>(
    api.reportAgent.aiSources.byKey(encodeURIComponent(input.key)),
    { method: 'PUT', body: { enabled: input.enabled } }
  );
};

export const getMyAiReportPromptReal: GetMyAiReportPromptContract = async () => {
  return await apiRequest<ReportAiPromptSettings>(api.reportAgent.aiReportPrompt.get(), { method: 'GET' });
};

export const updateMyAiReportPromptReal: UpdateMyAiReportPromptContract = async (input) => {
  return await apiRequest<ReportAiPromptSettings>(api.reportAgent.aiReportPrompt.update(), {
    method: 'PUT',
    body: { prompt: input.prompt },
  });
};

export const resetMyAiReportPromptReal: ResetMyAiReportPromptContract = async () => {
  return await apiRequest<ReportAiPromptSettings>(api.reportAgent.aiReportPrompt.reset(), { method: 'POST' });
};

export const getTeamAiSummaryPromptReal: GetTeamAiSummaryPromptContract = async (input) => {
  return await apiRequest<ReportAiPromptSettings>(
    api.reportAgent.teams.aiSummaryPrompt(encodeURIComponent(input.teamId)),
    { method: 'GET' }
  );
};

export const updateTeamAiSummaryPromptReal: UpdateTeamAiSummaryPromptContract = async (input) => {
  return await apiRequest<ReportAiPromptSettings>(
    api.reportAgent.teams.aiSummaryPrompt(encodeURIComponent(input.teamId)),
    {
      method: 'PUT',
      body: { prompt: input.prompt },
    }
  );
};

export const resetTeamAiSummaryPromptReal: ResetTeamAiSummaryPromptContract = async (input) => {
  return await apiRequest<ReportAiPromptSettings>(
    api.reportAgent.teams.aiSummaryPromptReset(encodeURIComponent(input.teamId)),
    { method: 'POST' }
  );
};

export const getMyDailyLogTagsReal: GetMyDailyLogTagsContract = async () => {
  return await apiRequest<{ items: string[] }>(api.reportAgent.dailyLogTags.get(), { method: 'GET' });
};

export const updateMyDailyLogTagsReal: UpdateMyDailyLogTagsContract = async (input) => {
  return await apiRequest<{ items: string[] }>(api.reportAgent.dailyLogTags.update(), {
    method: 'PUT',
    body: { items: input.items },
  });
};

export const listPersonalSourcesReal: ListPersonalSourcesContract = async () => {
  return await apiRequest<{ items: PersonalSource[] }>(api.reportAgent.personalSources.list(), { method: 'GET' });
};

export const createPersonalSourceReal: CreatePersonalSourceContract = async (input) => {
  return await apiRequest<{ source: PersonalSource }>(api.reportAgent.personalSources.list(), {
    method: 'POST',
    body: input,
  });
};

export const updatePersonalSourceReal: UpdatePersonalSourceContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest<{ source: PersonalSource }>(
    api.reportAgent.personalSources.byId(encodeURIComponent(id)),
    { method: 'PUT', body }
  );
};

export const deletePersonalSourceReal: DeletePersonalSourceContract = async (input) => {
  return await apiRequest<object>(
    api.reportAgent.personalSources.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const testPersonalSourceReal: TestPersonalSourceContract = async (input) => {
  return await apiRequest<{ success: boolean }>(
    api.reportAgent.personalSources.test(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const syncPersonalSourceReal: SyncPersonalSourceContract = async (input) => {
  return await apiRequest<{ success: boolean }>(
    api.reportAgent.personalSources.sync(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const getPersonalStatsReal: GetPersonalStatsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.weekYear != null) qs.set('weekYear', String(input.weekYear));
  if (input?.weekNumber != null) qs.set('weekNumber', String(input.weekNumber));
  const q = qs.toString();
  return await apiRequest<PersonalStats>(
    `${api.reportAgent.personalStats()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

// ========== Phase 5/6 v2.0: Team Workflow ==========

export const getTeamWorkflowReal: GetTeamWorkflowContract = async (input) => {
  return await apiRequest<TeamWorkflowInfo>(
    api.reportAgent.teamWorkflow(encodeURIComponent(input.teamId)),
    { method: 'GET' }
  );
};

export const runTeamWorkflowReal: RunTeamWorkflowContract = async (input) => {
  const { teamId, ...body } = input;
  return await apiRequest<{ executionId: string }>(
    api.reportAgent.teamWorkflowRun(encodeURIComponent(teamId)),
    { method: 'POST', body }
  );
};

// ========== Phase 5/6 v2.0: Identity Mappings ==========

export const updateIdentityMappingsReal: UpdateIdentityMappingsContract = async (input) => {
  const { teamId, userId, ...body } = input;
  return await apiRequest<{ member: ReportTeamMember }>(
    api.reportAgent.identityMappings(encodeURIComponent(teamId), encodeURIComponent(userId)),
    { method: 'PUT', body }
  );
};

// ========== Phase 6: Seed Templates ==========

export const seedSystemTemplatesReal: SeedSystemTemplatesContract = async () => {
  return await apiRequest<{ inserted: string[]; skipped: number }>(
    api.reportAgent.seedTemplates(),
    { method: 'POST' }
  );
};

// ========== Webhooks ==========

export const listWebhooksReal: ListWebhooksContract = async (input) => {
  return await apiRequest<{ items: ReportWebhookConfig[] }>(
    api.reportAgent.webhooks.list(encodeURIComponent(input.teamId)),
    { method: 'GET' }
  );
};

export const createWebhookReal: CreateWebhookContract = async (input) => {
  const { teamId, ...body } = input;
  return await apiRequest<{ webhook: ReportWebhookConfig }>(
    api.reportAgent.webhooks.list(encodeURIComponent(teamId)),
    { method: 'POST', body }
  );
};

export const updateWebhookReal: UpdateWebhookContract = async (input) => {
  const { teamId, webhookId, ...body } = input;
  return await apiRequest<{ webhook: ReportWebhookConfig }>(
    api.reportAgent.webhooks.byId(encodeURIComponent(teamId), encodeURIComponent(webhookId)),
    { method: 'PUT', body }
  );
};

export const deleteWebhookReal: DeleteWebhookContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.reportAgent.webhooks.byId(encodeURIComponent(input.teamId), encodeURIComponent(input.webhookId)),
    { method: 'DELETE' }
  );
};

export const testWebhookReal: TestWebhookContract = async (input) => {
  const { teamId, ...body } = input;
  return await apiRequest<{ success: boolean; error?: string }>(
    api.reportAgent.webhooks.test(encodeURIComponent(teamId)),
    { method: 'POST', body }
  );
};
