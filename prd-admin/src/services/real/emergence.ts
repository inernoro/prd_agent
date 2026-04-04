import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  CreateEmergenceTreeContract,
  ListEmergenceTreesContract,
  GetEmergenceTreeContract,
  DeleteEmergenceTreeContract,
  UpdateEmergenceNodeContract,
  DeleteEmergenceNodeContract,
  ExportEmergenceTreeContract,
} from '@/services/contracts/emergence';

export const createEmergenceTreeReal: CreateEmergenceTreeContract = async (input) => {
  return await apiRequest(api.emergence.trees.create(), {
    method: 'POST',
    body: input,
  });
};

export const listEmergenceTreesReal: ListEmergenceTreesContract = async (page = 1, pageSize = 20) => {
  return await apiRequest(`${api.emergence.trees.list()}?page=${page}&pageSize=${pageSize}`, {
    method: 'GET',
  });
};

export const getEmergenceTreeReal: GetEmergenceTreeContract = async (treeId) => {
  return await apiRequest(api.emergence.trees.detail(encodeURIComponent(treeId)), {
    method: 'GET',
  });
};

export const deleteEmergenceTreeReal: DeleteEmergenceTreeContract = async (treeId) => {
  return await apiRequest(api.emergence.trees.delete(encodeURIComponent(treeId)), {
    method: 'DELETE',
  });
};

export const updateEmergenceNodeReal: UpdateEmergenceNodeContract = async (nodeId, input) => {
  return await apiRequest(api.emergence.nodes.update(encodeURIComponent(nodeId)), {
    method: 'PUT',
    body: input,
  });
};

export const deleteEmergenceNodeReal: DeleteEmergenceNodeContract = async (nodeId) => {
  return await apiRequest(api.emergence.nodes.delete(encodeURIComponent(nodeId)), {
    method: 'DELETE',
  });
};

export const exportEmergenceTreeReal: ExportEmergenceTreeContract = async (treeId) => {
  return await apiRequest(api.emergence.trees.export(encodeURIComponent(treeId)), {
    method: 'GET',
  });
};
