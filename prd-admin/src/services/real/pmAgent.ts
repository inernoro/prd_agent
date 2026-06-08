import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  CreatePmProjectContract,
  ListPmProjectsContract,
  GetPmProjectContract,
  UpdatePmProjectContract,
  DeletePmProjectContract,
  CreatePmTaskContract,
  BatchCreatePmTasksContract,
  UpdatePmTaskContract,
  DeletePmTaskContract,
  SetPmStakeholdersContract,
  StartPmEvaluationContract,
  SubmitPmScoreContract,
  FinalizePmEvaluationContract,
  GetPmDashboardContract,
  GetPmRewardConfigContract,
  UpdatePmRewardConfigContract,
  TogglePmExcellenceContract,
  GetPmTaskActivitiesContract,
  AddPmTaskCommentContract,
  BulkPmTasksContract,
  ListPmTaskWorkLogsContract,
  CreatePmTaskWorkLogContract,
  UpdatePmTaskWorkLogContract,
  DeletePmTaskWorkLogContract,
  GetPmMembersContract,
  SetPmMembersContract,
  SetPmObserversContract,
  ListPmKnowledgeFilesContract,
  UpdatePmKnowledgeFileContract,
  DeletePmKnowledgeFileContract,
  GetPmMemberSitesContract,
  GetPmKnowledgeStoreContract,
  PmKnowledgeFile,
  ListPmDecisionsContract,
  CreatePmDecisionContract,
  UpdatePmDecisionContract,
  DeletePmDecisionContract,
  ListPmWeeklyReportsContract,
  CreatePmWeeklyReportContract,
  UpdatePmWeeklyReportContract,
  ListImportableWeeklyReportsContract,
  ImportWeeklyReportContract,
  DeletePmWeeklyReportContract,
  ListPmMeetingsContract,
  CreatePmMeetingContract,
  UpdatePmMeetingContract,
  DeletePmMeetingContract,
  ListPmGoalsContract,
  CreatePmGoalContract,
  UpdatePmGoalContract,
  SetGoalAsMilestoneContract,
  DeletePmGoalContract,
  ListPmGoalCheckInsContract,
  AddPmGoalCheckInContract,
  ScorePmGoalContract,
  ListPmGoalCyclesContract,
  CreatePmGoalCycleContract,
  UpdatePmGoalCycleContract,
  DeletePmGoalCycleContract,
  ListPmAuditLogsContract,
  ListPmMilestonesContract,
  CreatePmMilestoneContract,
  UpdatePmMilestoneContract,
  DeletePmMilestoneContract,
  ListPmRisksContract,
  CreatePmRiskContract,
  UpdatePmRiskContract,
  DeletePmRiskContract,
  GetPmBurndownContract,
} from '@/services/contracts/pmAgent';
import type { ApiResponse } from '@/types/api';
import { useAuthStore } from '@/stores/authStore';

export const createPmProjectReal: CreatePmProjectContract = async (input) => {
  return await apiRequest(api.pm.projects.create(), { method: 'POST', body: input });
};

export const listPmProjectsReal: ListPmProjectsContract = async (opts) => {
  const { page = 1, pageSize = 20, type, scope } = opts ?? {};
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (type) qs.set('type', type);
  if (scope) qs.set('scope', scope);
  return await apiRequest(`${api.pm.projects.list()}?${qs.toString()}`, { method: 'GET' });
};

export const getPmMembersReal: GetPmMembersContract = async (projectId) => {
  return await apiRequest(api.pm.projects.members(encodeURIComponent(projectId)), { method: 'GET' });
};

export const setPmMembersReal: SetPmMembersContract = async (projectId, memberIds) => {
  return await apiRequest(api.pm.projects.members(encodeURIComponent(projectId)), { method: 'PUT', body: { memberIds } });
};

export const setPmObserversReal: SetPmObserversContract = async (projectId, observerIds) => {
  return await apiRequest(api.pm.projects.observers(encodeURIComponent(projectId)), { method: 'PUT', body: { observerIds } });
};

// ── 知识库 ──
export const listPmKnowledgeFilesReal: ListPmKnowledgeFilesContract = async (projectId, category) => {
  const qs = category ? `?category=${encodeURIComponent(category)}` : '';
  return await apiRequest(`${api.pm.projects.knowledgeFiles(encodeURIComponent(projectId))}${qs}`, { method: 'GET' });
};

/** 知识库上传：FormData 必须走原生 fetch（apiRequest 会 JSON 序列化，见规则 #7） */
export const uploadPmKnowledgeFileReal = async (projectId: string, file: File, category?: string): Promise<ApiResponse<PmKnowledgeFile>> => {
  const token = useAuthStore.getState().token;
  const fd = new FormData();
  fd.append('file', file);
  if (category) fd.append('category', category);
  const res = await fetch(api.pm.projects.knowledgeFiles(encodeURIComponent(projectId)), {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: fd,
    credentials: 'include',
  });
  return await res.json();
};

export const updatePmKnowledgeFileReal: UpdatePmKnowledgeFileContract = async (fileId, input) => {
  return await apiRequest(api.pm.knowledge.file(encodeURIComponent(fileId)), { method: 'PUT', body: input });
};

export const deletePmKnowledgeFileReal: DeletePmKnowledgeFileContract = async (fileId) => {
  return await apiRequest(api.pm.knowledge.file(encodeURIComponent(fileId)), { method: 'DELETE' });
};

export const getPmMemberSitesReal: GetPmMemberSitesContract = async (projectId) => {
  return await apiRequest(api.pm.projects.memberSites(encodeURIComponent(projectId)), { method: 'GET' });
};

export const getPmKnowledgeStoreReal: GetPmKnowledgeStoreContract = async (projectId) => {
  return await apiRequest(api.pm.projects.knowledgeStore(encodeURIComponent(projectId)), { method: 'GET' });
};

// ── 决策事项 ──
export const listPmDecisionsReal: ListPmDecisionsContract = async (projectId) => {
  return await apiRequest(api.pm.projects.decisions(encodeURIComponent(projectId)), { method: 'GET' });
};

export const createPmDecisionReal: CreatePmDecisionContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.decisions(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const updatePmDecisionReal: UpdatePmDecisionContract = async (decisionId, input) => {
  return await apiRequest(api.pm.decisions.item(encodeURIComponent(decisionId)), { method: 'PUT', body: input });
};

export const deletePmDecisionReal: DeletePmDecisionContract = async (decisionId) => {
  return await apiRequest(api.pm.decisions.item(encodeURIComponent(decisionId)), { method: 'DELETE' });
};

// ── 项目周报 ──
export const listPmWeeklyReportsReal: ListPmWeeklyReportsContract = async (projectId) => {
  return await apiRequest(api.pm.projects.weeklyReports(encodeURIComponent(projectId)), { method: 'GET' });
};

export const createPmWeeklyReportReal: CreatePmWeeklyReportContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.weeklyReports(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const updatePmWeeklyReportReal: UpdatePmWeeklyReportContract = async (reportId, input) => {
  return await apiRequest(api.pm.weeklyReports.item(encodeURIComponent(reportId)), { method: 'PUT', body: input });
};

export const deletePmWeeklyReportReal: DeletePmWeeklyReportContract = async (reportId) => {
  return await apiRequest(api.pm.weeklyReports.item(encodeURIComponent(reportId)), { method: 'DELETE' });
};

export const listImportableWeeklyReportsReal: ListImportableWeeklyReportsContract = async (params) => {
  return await apiRequest(api.pm.weeklyReportsImportable(params), { method: 'GET' });
};

export const importWeeklyReportReal: ImportWeeklyReportContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.weeklyReportImport(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

/** 周报内嵌图片上传：FormData 必须走原生 fetch（apiRequest 会 JSON 序列化，见规则 #7） */
export const uploadPmWeeklyReportImageReal = async (projectId: string, file: File): Promise<ApiResponse<{ url: string }>> => {
  const token = useAuthStore.getState().token;
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(api.pm.projects.weeklyReportImage(encodeURIComponent(projectId)), {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: fd,
    credentials: 'include',
  });
  return await res.json();
};

// ── 会议纪要 ──
export const listPmMeetingsReal: ListPmMeetingsContract = async (projectId) => {
  return await apiRequest(api.pm.projects.meetings(encodeURIComponent(projectId)), { method: 'GET' });
};

export const createPmMeetingReal: CreatePmMeetingContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.meetings(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const updatePmMeetingReal: UpdatePmMeetingContract = async (meetingId, input) => {
  return await apiRequest(api.pm.meetings.item(encodeURIComponent(meetingId)), { method: 'PUT', body: input });
};

export const deletePmMeetingReal: DeletePmMeetingContract = async (meetingId) => {
  return await apiRequest(api.pm.meetings.item(encodeURIComponent(meetingId)), { method: 'DELETE' });
};

// ── 目标 / 计划 ──
export const listPmGoalsReal: ListPmGoalsContract = async (projectId) => {
  return await apiRequest(api.pm.projects.goals(encodeURIComponent(projectId)), { method: 'GET' });
};

export const createPmGoalReal: CreatePmGoalContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.goals(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const updatePmGoalReal: UpdatePmGoalContract = async (goalId, input) => {
  return await apiRequest(api.pm.goals.item(encodeURIComponent(goalId)), { method: 'PUT', body: input });
};

export const setGoalAsMilestoneReal: SetGoalAsMilestoneContract = async (goalId, enabled) => {
  return await apiRequest(api.pm.goals.milestone(encodeURIComponent(goalId)), { method: 'POST', body: { enabled } });
};

export const deletePmGoalReal: DeletePmGoalContract = async (goalId) => {
  return await apiRequest(api.pm.goals.item(encodeURIComponent(goalId)), { method: 'DELETE' });
};

export const listPmGoalCheckInsReal: ListPmGoalCheckInsContract = async (goalId) => {
  return await apiRequest(api.pm.goals.checkins(encodeURIComponent(goalId)), { method: 'GET' });
};
export const addPmGoalCheckInReal: AddPmGoalCheckInContract = async (goalId, input) => {
  return await apiRequest(api.pm.goals.checkins(encodeURIComponent(goalId)), { method: 'POST', body: input });
};
export const scorePmGoalReal: ScorePmGoalContract = async (goalId, input) => {
  return await apiRequest(api.pm.goals.score(encodeURIComponent(goalId)), { method: 'POST', body: input });
};
export const listPmGoalCyclesReal: ListPmGoalCyclesContract = async (projectId) => {
  return await apiRequest(api.pm.projects.goalCycles(encodeURIComponent(projectId)), { method: 'GET' });
};
export const createPmGoalCycleReal: CreatePmGoalCycleContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.goalCycles(encodeURIComponent(projectId)), { method: 'POST', body: input });
};
export const updatePmGoalCycleReal: UpdatePmGoalCycleContract = async (cycleId, input) => {
  return await apiRequest(api.pm.goalCycles.item(encodeURIComponent(cycleId)), { method: 'PUT', body: input });
};
export const deletePmGoalCycleReal: DeletePmGoalCycleContract = async (cycleId) => {
  return await apiRequest(api.pm.goalCycles.item(encodeURIComponent(cycleId)), { method: 'DELETE' });
};

// ── 审计日志 ──
export const listPmAuditLogsReal: ListPmAuditLogsContract = async (opts) => {
  const { projectId, page = 1, pageSize = 50 } = opts ?? {};
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (projectId) qs.set('projectId', projectId);
  return await apiRequest(`${api.pm.auditLogs()}?${qs.toString()}`, { method: 'GET' });
};

// ── 里程碑 ──
export const listPmMilestonesReal: ListPmMilestonesContract = async (projectId) => {
  return await apiRequest(api.pm.projects.milestones(encodeURIComponent(projectId)), { method: 'GET' });
};

export const createPmMilestoneReal: CreatePmMilestoneContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.milestones(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const updatePmMilestoneReal: UpdatePmMilestoneContract = async (milestoneId, input) => {
  return await apiRequest(api.pm.milestones.item(encodeURIComponent(milestoneId)), { method: 'PUT', body: input });
};

export const deletePmMilestoneReal: DeletePmMilestoneContract = async (milestoneId) => {
  return await apiRequest(api.pm.milestones.item(encodeURIComponent(milestoneId)), { method: 'DELETE' });
};

// ── 风险登记册 ──
export const listPmRisksReal: ListPmRisksContract = async (projectId) => {
  return await apiRequest(api.pm.projects.risks(encodeURIComponent(projectId)), { method: 'GET' });
};
export const createPmRiskReal: CreatePmRiskContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.risks(encodeURIComponent(projectId)), { method: 'POST', body: input });
};
export const updatePmRiskReal: UpdatePmRiskContract = async (riskId, input) => {
  return await apiRequest(api.pm.risks.item(encodeURIComponent(riskId)), { method: 'PUT', body: input });
};
export const deletePmRiskReal: DeletePmRiskContract = async (riskId) => {
  return await apiRequest(api.pm.risks.item(encodeURIComponent(riskId)), { method: 'DELETE' });
};

export const getPmBurndownReal: GetPmBurndownContract = async (projectId) => {
  return await apiRequest(api.pm.projects.burndown(encodeURIComponent(projectId)), { method: 'GET' });
};

export const getPmProjectReal: GetPmProjectContract = async (projectId) => {
  return await apiRequest(api.pm.projects.detail(encodeURIComponent(projectId)), { method: 'GET' });
};

export const updatePmProjectReal: UpdatePmProjectContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.update(encodeURIComponent(projectId)), { method: 'PUT', body: input });
};

export const deletePmProjectReal: DeletePmProjectContract = async (projectId) => {
  return await apiRequest(api.pm.projects.delete(encodeURIComponent(projectId)), { method: 'DELETE' });
};

export const createPmTaskReal: CreatePmTaskContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.createTask(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const batchCreatePmTasksReal: BatchCreatePmTasksContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.batchTasks(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const updatePmTaskReal: UpdatePmTaskContract = async (taskId, input) => {
  return await apiRequest(api.pm.tasks.update(encodeURIComponent(taskId)), { method: 'PUT', body: input });
};

export const deletePmTaskReal: DeletePmTaskContract = async (taskId) => {
  return await apiRequest(api.pm.tasks.delete(encodeURIComponent(taskId)), { method: 'DELETE' });
};

export const setPmStakeholdersReal: SetPmStakeholdersContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.stakeholders(encodeURIComponent(projectId)), { method: 'PUT', body: input });
};

export const startPmEvaluationReal: StartPmEvaluationContract = async (projectId) => {
  return await apiRequest(api.pm.projects.evaluationStart(encodeURIComponent(projectId)), { method: 'POST', body: {} });
};

export const submitPmScoreReal: SubmitPmScoreContract = async (projectId, stakeholderId, score) => {
  return await apiRequest(api.pm.projects.evaluationScore(encodeURIComponent(projectId)), { method: 'POST', body: { stakeholderId, score } });
};

export const finalizePmEvaluationReal: FinalizePmEvaluationContract = async (projectId) => {
  return await apiRequest(api.pm.projects.evaluationFinalize(encodeURIComponent(projectId)), { method: 'POST', body: {} });
};

export const getPmDashboardReal: GetPmDashboardContract = async (fiscalYear) => {
  const url = fiscalYear != null ? `${api.pm.dashboard()}?fiscalYear=${fiscalYear}` : api.pm.dashboard();
  return await apiRequest(url, { method: 'GET' });
};

export const togglePmExcellenceReal: TogglePmExcellenceContract = async (projectId, isExcellent) => {
  return await apiRequest(api.pm.projects.excellence(encodeURIComponent(projectId)), { method: 'POST', body: { isExcellent } });
};

export const getPmTaskActivitiesReal: GetPmTaskActivitiesContract = async (taskId) => {
  return await apiRequest(api.pm.tasks.activities(encodeURIComponent(taskId)), { method: 'GET' });
};

export const addPmTaskCommentReal: AddPmTaskCommentContract = async (taskId, content, mentionedUserIds) => {
  return await apiRequest(api.pm.tasks.comments(encodeURIComponent(taskId)), { method: 'POST', body: { content, mentionedUserIds } });
};

export const bulkPmTasksReal: BulkPmTasksContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.bulkTasks(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const listPmTaskWorkLogsReal: ListPmTaskWorkLogsContract = async (taskId) => {
  return await apiRequest(api.pm.tasks.workLogs(encodeURIComponent(taskId)), { method: 'GET' });
};

export const createPmTaskWorkLogReal: CreatePmTaskWorkLogContract = async (taskId, input) => {
  return await apiRequest(api.pm.tasks.workLogs(encodeURIComponent(taskId)), { method: 'POST', body: input });
};

export const updatePmTaskWorkLogReal: UpdatePmTaskWorkLogContract = async (logId, input) => {
  return await apiRequest(api.pm.workLogs.update(encodeURIComponent(logId)), { method: 'PUT', body: input });
};

export const deletePmTaskWorkLogReal: DeletePmTaskWorkLogContract = async (logId) => {
  return await apiRequest(api.pm.workLogs.delete(encodeURIComponent(logId)), { method: 'DELETE' });
};

export const getPmRewardConfigReal: GetPmRewardConfigContract = async () => {
  return await apiRequest(api.pm.rewardConfig(), { method: 'GET' });
};

export const updatePmRewardConfigReal: UpdatePmRewardConfigContract = async (input) => {
  return await apiRequest(api.pm.rewardConfig(), { method: 'PUT', body: input });
};
