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
import { api } from '@/services/api';

export const exportConfigReal: ExportConfigContract = async () => {
  return await apiRequest(api.data.config.export());
};

export const importConfigReal: ImportConfigContract = async (input) => {
  return await apiRequest(api.data.config.import(), {
    method: 'POST',
    body: input,
  });
};

export const previewImportConfigReal: PreviewImportConfigContract = async (input) => {
  return await apiRequest(api.data.config.importPreview(), {
    method: 'POST',
    body: input,
  });
};

export const getDataSummaryReal: GetDataSummaryContract = async () => {
  return await apiRequest(api.data.summary());
};

export const purgeDataReal: PurgeDataContract = async (input, idempotencyKey) => {
  return await apiRequest(api.data.purge(), {
    method: 'POST',
    body: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
};

export const previewUsersPurgeReal: PreviewUsersPurgeContract = async (limit) => {
  const qs = typeof limit === 'number' ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return await apiRequest(`${api.data.users.preview()}${qs}`);
};

export const purgeUsersReal: PurgeUsersContract = async (input, idempotencyKey) => {
  return await apiRequest(api.data.users.purge(), {
    method: 'POST',
    body: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
};


