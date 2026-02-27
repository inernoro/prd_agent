import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  ListReportTeamsContract,
  GetReportTeamContract,
  CreateReportTeamContract,
  UpdateReportTeamContract,
  DeleteReportTeamContract,
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
  GetPlanComparisonContract,
  GenerateTeamSummaryContract,
  GetTeamSummaryContract,
  DailyLog,
  ReportDataSource,
  ReportCommit,
  CollectedActivity,
  ReportTeam,
  ReportTeamMember,
  ReportTemplate,
  WeeklyReport,
  ReportUser,
  TeamDashboardData,
  ReportComment,
  PlanComparison,
  TeamSummary,
} from '../contracts/reportAgent';

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
  return await apiRequest<{ report: WeeklyReport }>(api.reportAgent.reports.list(), {
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
