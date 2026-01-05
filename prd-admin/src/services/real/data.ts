import type {
  ExportConfigContract,
  GetDataSummaryContract,
  ImportConfigContract,
  PreviewImportConfigContract,
  PreviewUsersPurgeContract,
  PurgeDataContract,
  PurgeUsersContract,
} from '@/services/contracts/data';
import { apiRequest } from '@/services/real/apiClient';

export const exportConfigReal: ExportConfigContract = async () => {
  return await apiRequest('/api/v1/admin/data/config/export');
};

export const importConfigReal: ImportConfigContract = async (input) => {
  return await apiRequest('/api/v1/admin/data/config/import', {
    method: 'POST',
    body: input,
  });
};

export const previewImportConfigReal: PreviewImportConfigContract = async (input) => {
  return await apiRequest('/api/v1/admin/data/config/import/preview', {
    method: 'POST',
    body: input,
  });
};

export const getDataSummaryReal: GetDataSummaryContract = async () => {
  return await apiRequest('/api/v1/admin/data/summary');
};

export const purgeDataReal: PurgeDataContract = async (input, idempotencyKey) => {
  return await apiRequest('/api/v1/admin/data/purge', {
    method: 'POST',
    body: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
};

export const previewUsersPurgeReal: PreviewUsersPurgeContract = async (limit) => {
  const qs = typeof limit === 'number' ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return await apiRequest(`/api/v1/admin/data/users/preview${qs}`);
};

export const purgeUsersReal: PurgeUsersContract = async (input, idempotencyKey) => {
  return await apiRequest('/api/v1/admin/data/users/purge', {
    method: 'POST',
    body: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
};


