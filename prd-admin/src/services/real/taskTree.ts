import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  CreateTaskTreeContract,
  ListTaskTreesContract,
  GetTaskTreeContract,
  DeleteTaskTreeContract,
  CreateTaskNodeContract,
  UpdateTaskNodeContract,
  DeleteTaskNodeContract,
  AddTaskDependencyContract,
  RemoveTaskDependencyContract,
  ListTaskBlockersContract,
} from '@/services/contracts/taskTree';

export const createTaskTreeReal: CreateTaskTreeContract = async (input) => {
  return await apiRequest(api.taskTree.trees.create(), { method: 'POST', body: input });
};

export const listTaskTreesReal: ListTaskTreesContract = async (includeArchived = false) => {
  return await apiRequest(`${api.taskTree.trees.list()}?includeArchived=${includeArchived}`, {
    method: 'GET',
  });
};

export const getTaskTreeReal: GetTaskTreeContract = async (treeId) => {
  return await apiRequest(api.taskTree.trees.detail(encodeURIComponent(treeId)), { method: 'GET' });
};

export const deleteTaskTreeReal: DeleteTaskTreeContract = async (treeId) => {
  return await apiRequest(api.taskTree.trees.delete(encodeURIComponent(treeId)), {
    method: 'DELETE',
  });
};

export const createTaskNodeReal: CreateTaskNodeContract = async (treeId, input) => {
  return await apiRequest(api.taskTree.trees.nodes(encodeURIComponent(treeId)), {
    method: 'POST',
    body: input,
  });
};

export const updateTaskNodeReal: UpdateTaskNodeContract = async (nodeId, input) => {
  return await apiRequest(api.taskTree.nodes.update(encodeURIComponent(nodeId)), {
    method: 'PUT',
    body: input,
  });
};

export const deleteTaskNodeReal: DeleteTaskNodeContract = async (nodeId) => {
  return await apiRequest(api.taskTree.nodes.delete(encodeURIComponent(nodeId)), {
    method: 'DELETE',
  });
};

export const addTaskDependencyReal: AddTaskDependencyContract = async (nodeId, dependsOnId) => {
  return await apiRequest(api.taskTree.nodes.addDependency(encodeURIComponent(nodeId)), {
    method: 'POST',
    body: { dependsOnId },
  });
};

export const removeTaskDependencyReal: RemoveTaskDependencyContract = async (nodeId, dependsOnId) => {
  return await apiRequest(
    api.taskTree.nodes.removeDependency(encodeURIComponent(nodeId), encodeURIComponent(dependsOnId)),
    { method: 'DELETE' }
  );
};

export const listTaskBlockersReal: ListTaskBlockersContract = async (scope = 'mine') => {
  return await apiRequest(`${api.taskTree.blockers()}?scope=${scope}`, { method: 'GET' });
};
