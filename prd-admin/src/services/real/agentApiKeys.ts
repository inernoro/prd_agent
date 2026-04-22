import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  CreateAgentApiKeyContract,
  DeleteAgentApiKeyContract,
  ListAgentApiKeysContract,
  RenewAgentApiKeyContract,
  RevokeAgentApiKeyContract,
  UpdateAgentApiKeyContract,
} from '@/services/contracts/agentApiKeys';

export const listAgentApiKeysReal: ListAgentApiKeysContract = async () => {
  return await apiRequest(api.agentApiKeys.list(), { method: 'GET' });
};

export const createAgentApiKeyReal: CreateAgentApiKeyContract = async (input) => {
  return await apiRequest(api.agentApiKeys.create(), {
    method: 'POST',
    body: {
      name: input.name,
      description: input.description,
      scopes: input.scopes,
      ttlDays: input.ttlDays,
    },
  });
};

export const updateAgentApiKeyReal: UpdateAgentApiKeyContract = async (input) => {
  return await apiRequest(api.agentApiKeys.update(encodeURIComponent(input.id)), {
    method: 'PATCH',
    body: {
      name: input.name,
      description: input.description,
      scopes: input.scopes,
      isActive: input.isActive,
    },
  });
};

export const renewAgentApiKeyReal: RenewAgentApiKeyContract = async (input) => {
  return await apiRequest(api.agentApiKeys.renew(encodeURIComponent(input.id)), {
    method: 'POST',
    body: { ttlDays: input.ttlDays },
  });
};

export const revokeAgentApiKeyReal: RevokeAgentApiKeyContract = async (input) => {
  return await apiRequest(api.agentApiKeys.revoke(encodeURIComponent(input.id)), {
    method: 'POST',
    body: {},
  });
};

export const deleteAgentApiKeyReal: DeleteAgentApiKeyContract = async (input) => {
  return await apiRequest(api.agentApiKeys.byId(encodeURIComponent(input.id)), {
    method: 'DELETE',
    emptyResponseData: { deleted: true },
  });
};
