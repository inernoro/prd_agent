import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  GetMcpConsoleOverviewContract,
  GetMcpVisibleToolsContract,
  ListMcpCallsContract,
} from '@/services/contracts/mcpConsole';

export const getMcpConsoleOverviewReal: GetMcpConsoleOverviewContract = async () => {
  return await apiRequest(api.mcpConsole.overview(), { method: 'GET' });
};

export const listMcpCallsReal: ListMcpCallsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.keyId) qs.set('keyId', input.keyId);
  if (input.capability) qs.set('capability', input.capability);
  if (input.status) qs.set('status', input.status);
  if (input.skip) qs.set('skip', String(input.skip));
  if (input.limit) qs.set('limit', String(input.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return await apiRequest(api.mcpConsole.calls(suffix), { method: 'GET' });
};


export const getMcpVisibleToolsReal: GetMcpVisibleToolsContract = async (keyId) => {
  return await apiRequest(api.mcpConsole.visibleTools(encodeURIComponent(keyId)), { method: 'GET' });
};
