import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  ListTransfersContract,
  GetTransferContract,
  CreateTransferContract,
  AcceptTransferContract,
  RejectTransferContract,
  CancelTransferContract,
  ListMyWorkspacesContract,
  ListMyConfigsContract,
  AccountDataTransfer,
  ShareableWorkspace,
  ShareablePrompt,
  ShareableRefImage,
  DataTransferResult,
} from '@/services/contracts/dataTransfer';

export const listTransfersReal: ListTransfersContract = async (direction) => {
  const qs = direction ? `?direction=${direction}` : '';
  return await apiRequest<{ items: AccountDataTransfer[] }>(`${api.accountDataTransfer.list()}${qs}`, { method: 'GET' });
};

export const getTransferReal: GetTransferContract = async (id) => {
  return await apiRequest<{ transfer: AccountDataTransfer }>(api.accountDataTransfer.byId(id), { method: 'GET' });
};

export const createTransferReal: CreateTransferContract = async (req) => {
  return await apiRequest<{ id: string; itemCount: number }>(api.accountDataTransfer.create(), {
    method: 'POST',
    body: req,
  });
};

export const acceptTransferReal: AcceptTransferContract = async (id) => {
  return await apiRequest<{ status: string; result: DataTransferResult }>(api.accountDataTransfer.accept(id), {
    method: 'POST',
    body: '{}',
  });
};

export const rejectTransferReal: RejectTransferContract = async (id) => {
  return await apiRequest<{ status: string }>(api.accountDataTransfer.reject(id), {
    method: 'POST',
    body: '{}',
  });
};

export const cancelTransferReal: CancelTransferContract = async (id) => {
  return await apiRequest<{ status: string }>(api.accountDataTransfer.cancel(id), {
    method: 'POST',
    body: '{}',
  });
};

export const listMyWorkspacesReal: ListMyWorkspacesContract = async (scenarioType) => {
  const qs = scenarioType ? `?scenarioType=${encodeURIComponent(scenarioType)}` : '';
  return await apiRequest<{ items: ShareableWorkspace[] }>(`${api.accountDataTransfer.myWorkspaces()}${qs}`, { method: 'GET' });
};

export const listMyConfigsReal: ListMyConfigsContract = async () => {
  return await apiRequest<{ prompts: ShareablePrompt[]; refImages: ShareableRefImage[] }>(api.accountDataTransfer.myConfigs(), { method: 'GET' });
};
