import { apiRequest } from './apiClient';
import { uploadReportImageForm } from './reportAgent';
import { api } from '@/services/api';
import type {
  CreateCommentContract,
  DeleteCommentContract,
  LikeReportContract,
  ListCommentsContract,
  ListReportLikesContract,
  ReportComment,
  ReportLikeSummary,
  ReportViewSummary,
  UnlikeReportContract,
  UpdateCommentContract,
  UploadReportCommentImageContract,
} from '@/services/contracts/reportAgent';
import type {
  MonthlyReport,
  MonthlyReportDetail,
  MonthlyTeamOverview,
  MonthlyWeeklyCandidate,
  UpdateMonthlyReportInput,
} from '@/services/contracts/reportAgentMonthly';

const routes = api.reportAgent.monthlyReports;
const enc = encodeURIComponent;

export async function listMonthlyReportsReal(input: {
  scope?: 'my' | 'team';
  teamId?: string;
  year?: number;
  month?: number;
}) {
  const qs = new URLSearchParams();
  if (input.scope) qs.set('scope', input.scope);
  if (input.teamId) qs.set('teamId', input.teamId);
  if (input.year != null) qs.set('year', String(input.year));
  if (input.month != null) qs.set('month', String(input.month));
  const q = qs.toString();
  return await apiRequest<{ items: MonthlyReport[] }>(`${routes.list()}${q ? `?${q}` : ''}`, { method: 'GET' });
}

export async function getMonthlyReportReal(input: { id: string }) {
  return await apiRequest<MonthlyReportDetail>(routes.byId(enc(input.id)), { method: 'GET' });
}

export async function createMonthlyReportReal(input: { teamId: string; year: number; month: number }) {
  return await apiRequest<{ report: MonthlyReport; existed: boolean }>(routes.list(), {
    method: 'POST',
    body: input,
  });
}

export async function updateMonthlyReportReal(input: UpdateMonthlyReportInput) {
  const { id, ...body } = input;
  return await apiRequest<MonthlyReportDetail>(routes.byId(enc(id)), { method: 'PUT', body });
}

export async function deleteMonthlyReportReal(input: { id: string }) {
  return await apiRequest<object>(routes.byId(enc(input.id)), { method: 'DELETE' });
}

export async function submitMonthlyReportReal(input: { id: string }) {
  return await apiRequest<MonthlyReportDetail>(routes.submit(enc(input.id)), { method: 'POST' });
}

export async function recordMonthlyReportViewReal(input: { id: string }) {
  return await apiRequest<{ viewedAt: string }>(routes.views(enc(input.id)), { method: 'POST' });
}

export async function getMonthlyReportViewsSummaryReal(input: { id: string }) {
  return await apiRequest<ReportViewSummary>(routes.viewsSummary(enc(input.id)), { method: 'GET' });
}

export async function listMonthlyWeeklyCandidatesReal(input: { teamId: string; year: number; month: number }) {
  const qs = new URLSearchParams({
    teamId: input.teamId,
    year: String(input.year),
    month: String(input.month),
  });
  return await apiRequest<{ items: MonthlyWeeklyCandidate[] }>(`${routes.weeklyCandidates()}?${qs.toString()}`, {
    method: 'GET',
  });
}

export async function getMonthlyTeamOverviewReal(input: { teamId: string; year: number; month: number }) {
  const qs = new URLSearchParams({
    teamId: input.teamId,
    year: String(input.year),
    month: String(input.month),
  });
  return await apiRequest<MonthlyTeamOverview>(`${routes.teamOverview()}?${qs.toString()}`, { method: 'GET' });
}

// ========== 互动（与周报同一套契约，入参里的 reportId 即月报 Id） ==========

export const listMonthlyCommentsReal: ListCommentsContract = async (input) => {
  const q = input.sectionIndex != null ? `?sectionIndex=${input.sectionIndex}` : '';
  return await apiRequest<{ items: ReportComment[] }>(`${routes.comments(enc(input.reportId))}${q}`, { method: 'GET' });
};

export const createMonthlyCommentReal: CreateCommentContract = async (input) => {
  const { reportId, ...body } = input;
  return await apiRequest<{ comment: ReportComment }>(routes.comments(enc(reportId)), { method: 'POST', body });
};

export const updateMonthlyCommentReal: UpdateCommentContract = async (input) => {
  return await apiRequest<{ comment: ReportComment }>(routes.comment(enc(input.reportId), enc(input.commentId)), {
    method: 'PUT',
    body: { content: input.content },
  });
};

export const deleteMonthlyCommentReal: DeleteCommentContract = async (input) => {
  return await apiRequest<object>(routes.comment(enc(input.reportId), enc(input.commentId)), { method: 'DELETE' });
};

export const uploadMonthlyCommentImageReal: UploadReportCommentImageContract = async (input) => {
  return await uploadReportImageForm(routes.commentImages(enc(input.reportId)), input.file);
};

export const listMonthlyLikesReal: ListReportLikesContract = async (input) => {
  return await apiRequest<ReportLikeSummary>(routes.likes(enc(input.reportId)), { method: 'GET' });
};

export const likeMonthlyReportReal: LikeReportContract = async (input) => {
  return await apiRequest<ReportLikeSummary>(routes.likes(enc(input.reportId)), { method: 'POST' });
};

export const unlikeMonthlyReportReal: UnlikeReportContract = async (input) => {
  return await apiRequest<ReportLikeSummary>(routes.likes(enc(input.reportId)), { method: 'DELETE' });
};
