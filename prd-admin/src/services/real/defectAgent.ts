import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  DefectReport,
  DefectReview,
  DefectFix,
  DefectRepoConfig,
  DefectStats,
  ListDefectsContract,
  GetDefectContract,
  CreateDefectContract,
  UpdateDefectContract,
  DeleteDefectContract,
  SubmitDefectContract,
  TriggerFixContract,
  VerifyFixContract,
  CloseDefectContract,
  ReopenDefectContract,
  GetReviewsContract,
  GetFixesContract,
  ListRepoConfigsContract,
  CreateRepoConfigContract,
  UpdateRepoConfigContract,
  DeleteRepoConfigContract,
  GetDefectStatsContract,
} from '@/services/contracts/defectAgent';

// ============ Defects ============

export const listDefectsReal: ListDefectsContract = async (params) => {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.priority) searchParams.set('priority', params.priority);
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  const qs = searchParams.toString();
  const url = api.defectAgent.defects.list() + (qs ? `?${qs}` : '');
  return await apiRequest<{ items: DefectReport[]; total: number }>(url, { method: 'GET' });
};

export const getDefectReal: GetDefectContract = async (id) => {
  return await apiRequest<{ defect: DefectReport }>(api.defectAgent.defects.byId(id), { method: 'GET' });
};

export const createDefectReal: CreateDefectContract = async (input) => {
  return await apiRequest<{ defect: DefectReport }>(api.defectAgent.defects.create(), {
    method: 'POST',
    body: input,
  });
};

export const updateDefectReal: UpdateDefectContract = async (id, input) => {
  return await apiRequest<{ defect: DefectReport }>(api.defectAgent.defects.byId(id), {
    method: 'PUT',
    body: input,
  });
};

export const deleteDefectReal: DeleteDefectContract = async (id) => {
  return await apiRequest<{ deleted: boolean }>(api.defectAgent.defects.byId(id), { method: 'DELETE' });
};

// ============ Status Actions ============

export const submitDefectReal: SubmitDefectContract = async (id) => {
  return await apiRequest<{ runId: string }>(api.defectAgent.defects.submit(id), { method: 'POST' });
};

export const triggerFixReal: TriggerFixContract = async (id) => {
  return await apiRequest<{ runId: string }>(api.defectAgent.defects.fix(id), { method: 'POST' });
};

export const verifyFixReal: VerifyFixContract = async (id) => {
  return await apiRequest<{ verified: boolean }>(api.defectAgent.defects.verify(id), { method: 'POST' });
};

export const closeDefectReal: CloseDefectContract = async (id) => {
  return await apiRequest<{ closed: boolean }>(api.defectAgent.defects.close(id), { method: 'POST' });
};

export const reopenDefectReal: ReopenDefectContract = async (id) => {
  return await apiRequest<{ reopened: boolean }>(api.defectAgent.defects.reopen(id), { method: 'POST' });
};

// ============ Reviews & Fixes ============

export const getReviewsReal: GetReviewsContract = async (defectId) => {
  return await apiRequest<{ reviews: DefectReview[] }>(api.defectAgent.defects.reviews(defectId), { method: 'GET' });
};

export const getFixesReal: GetFixesContract = async (defectId) => {
  return await apiRequest<{ fixes: DefectFix[] }>(api.defectAgent.defects.fixes(defectId), { method: 'GET' });
};

// ============ Repo Configs ============

export const listRepoConfigsReal: ListRepoConfigsContract = async () => {
  return await apiRequest<{ configs: DefectRepoConfig[] }>(api.defectAgent.repos.list(), { method: 'GET' });
};

export const createRepoConfigReal: CreateRepoConfigContract = async (input) => {
  return await apiRequest<{ config: DefectRepoConfig }>(api.defectAgent.repos.create(), {
    method: 'POST',
    body: input,
  });
};

export const updateRepoConfigReal: UpdateRepoConfigContract = async (id, input) => {
  return await apiRequest<{ config: DefectRepoConfig }>(api.defectAgent.repos.byId(id), {
    method: 'PUT',
    body: input,
  });
};

export const deleteRepoConfigReal: DeleteRepoConfigContract = async (id) => {
  return await apiRequest<{ deleted: boolean }>(api.defectAgent.repos.byId(id), { method: 'DELETE' });
};

// ============ Stats ============

export const getDefectStatsReal: GetDefectStatsContract = async () => {
  return await apiRequest<DefectStats>(api.defectAgent.stats.overview(), { method: 'GET' });
};
