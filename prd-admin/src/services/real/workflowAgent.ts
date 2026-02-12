import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  ListWorkflowsContract,
  CreateWorkflowContract,
  GetWorkflowContract,
  UpdateWorkflowContract,
  DeleteWorkflowContract,
  ExecuteWorkflowContract,
  ListExecutionsContract,
  GetExecutionContract,
  CancelExecutionContract,
  ResumeFromNodeContract,
  GetNodeLogsContract,
  CreateShareLinkContract,
  ListShareLinksContract,
  RevokeShareContract,
  Workflow,
  WorkflowExecution,
  ShareLink,
  ExecutionArtifact,
} from '../contracts/workflowAgent';

// ========== Workflows ==========

export const listWorkflowsReal: ListWorkflowsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.tag) qs.set('tag', input.tag);
  if (input?.page) qs.set('page', String(input.page));
  if (input?.pageSize) qs.set('pageSize', String(input.pageSize));
  const query = qs.toString();
  return await apiRequest<{ items: Workflow[]; total: number }>(
    api.workflowAgent.workflows.list() + (query ? `?${query}` : ''),
    { method: 'GET' }
  );
};

export const createWorkflowReal: CreateWorkflowContract = async (input) => {
  return await apiRequest<{ workflow: Workflow }>(
    api.workflowAgent.workflows.list(),
    { method: 'POST', body: input }
  );
};

export const getWorkflowReal: GetWorkflowContract = async (id) => {
  return await apiRequest<{ workflow: Workflow }>(
    api.workflowAgent.workflows.byId(id),
    { method: 'GET' }
  );
};

export const updateWorkflowReal: UpdateWorkflowContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest<{ workflow: Workflow }>(
    api.workflowAgent.workflows.byId(id),
    { method: 'PUT', body }
  );
};

export const deleteWorkflowReal: DeleteWorkflowContract = async (id) => {
  return await apiRequest<{ deleted: boolean }>(
    api.workflowAgent.workflows.byId(id),
    { method: 'DELETE' }
  );
};

export const executeWorkflowReal: ExecuteWorkflowContract = async (input) => {
  const { id, variables } = input;
  return await apiRequest<{ execution: WorkflowExecution }>(
    api.workflowAgent.workflows.execute(id),
    { method: 'POST', body: { variables } }
  );
};

// ========== Executions ==========

export const listExecutionsReal: ListExecutionsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.workflowId) qs.set('workflowId', input.workflowId);
  if (input?.status) qs.set('status', input.status);
  if (input?.page) qs.set('page', String(input.page));
  if (input?.pageSize) qs.set('pageSize', String(input.pageSize));
  const query = qs.toString();
  return await apiRequest<{ items: WorkflowExecution[]; total: number }>(
    api.workflowAgent.executions.list() + (query ? `?${query}` : ''),
    { method: 'GET' }
  );
};

export const getExecutionReal: GetExecutionContract = async (id) => {
  return await apiRequest<{ execution: WorkflowExecution }>(
    api.workflowAgent.executions.byId(id),
    { method: 'GET' }
  );
};

export const cancelExecutionReal: CancelExecutionContract = async (id) => {
  return await apiRequest<{ cancelled: boolean }>(
    api.workflowAgent.executions.cancel(id),
    { method: 'POST' }
  );
};

export const resumeFromNodeReal: ResumeFromNodeContract = async (input) => {
  return await apiRequest<{ execution: WorkflowExecution }>(
    api.workflowAgent.executions.resumeFrom(input.executionId, input.nodeId),
    { method: 'POST' }
  );
};

export const getNodeLogsReal: GetNodeLogsContract = async (input) => {
  return await apiRequest<{
    nodeId: string;
    nodeName: string;
    status: string;
    logs?: string;
    errorMessage?: string;
    artifacts: ExecutionArtifact[];
  }>(
    api.workflowAgent.executions.nodeLogs(input.executionId, input.nodeId),
    { method: 'GET' }
  );
};

// ========== Shares ==========

export const createShareLinkReal: CreateShareLinkContract = async (input) => {
  const { executionId, ...body } = input;
  return await apiRequest<{ shareLink: ShareLink; url: string }>(
    api.workflowAgent.shares.create(executionId),
    { method: 'POST', body }
  );
};

export const listShareLinksReal: ListShareLinksContract = async () => {
  return await apiRequest<{ items: ShareLink[] }>(
    api.workflowAgent.shares.list(),
    { method: 'GET' }
  );
};

export const revokeShareReal: RevokeShareContract = async (shareId) => {
  return await apiRequest<{ revoked: boolean }>(
    api.workflowAgent.shares.revoke(shareId),
    { method: 'DELETE' }
  );
};
