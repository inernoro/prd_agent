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
  EvaluatePmProjectContract,
} from '@/services/contracts/pmAgent';

export const createPmProjectReal: CreatePmProjectContract = async (input) => {
  return await apiRequest(api.pm.projects.create(), { method: 'POST', body: input });
};

export const listPmProjectsReal: ListPmProjectsContract = async (page = 1, pageSize = 20, type) => {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (type) qs.set('type', type);
  return await apiRequest(`${api.pm.projects.list()}?${qs.toString()}`, { method: 'GET' });
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

export const evaluatePmProjectReal: EvaluatePmProjectContract = async (projectId, scores) => {
  return await apiRequest(api.pm.projects.evaluate(encodeURIComponent(projectId)), { method: 'POST', body: { scores } });
};
