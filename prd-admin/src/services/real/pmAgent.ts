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
  GetPmMembersContract,
  SetPmMembersContract,
  ListPmKnowledgeFilesContract,
  UpdatePmKnowledgeFileContract,
  DeletePmKnowledgeFileContract,
  GetPmMemberSitesContract,
  PmKnowledgeFile,
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

export const addPmTaskCommentReal: AddPmTaskCommentContract = async (taskId, content) => {
  return await apiRequest(api.pm.tasks.comments(encodeURIComponent(taskId)), { method: 'POST', body: { content } });
};

export const bulkPmTasksReal: BulkPmTasksContract = async (projectId, input) => {
  return await apiRequest(api.pm.projects.bulkTasks(encodeURIComponent(projectId)), { method: 'POST', body: input });
};

export const getPmRewardConfigReal: GetPmRewardConfigContract = async () => {
  return await apiRequest(api.pm.rewardConfig(), { method: 'GET' });
};

export const updatePmRewardConfigReal: UpdatePmRewardConfigContract = async (input) => {
  return await apiRequest(api.pm.rewardConfig(), { method: 'PUT', body: input });
};
