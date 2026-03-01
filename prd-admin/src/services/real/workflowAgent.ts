import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
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
  ListCapsuleTypesContract,
  GetCapsuleTypeContract,
  TestRunCapsuleContract,
  GetChatHistoryContract,
  ChatWorkflowContract,
  AnalyzeExecutionContract,
  Workflow,
  WorkflowExecution,
  WorkflowChatMessage,
  ShareLink,
  ExecutionArtifact,
  CapsuleTypeMeta,
  CapsuleCategoryInfo,
  CapsuleTestRunResult,
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

// ========== Capsule Types (舱类型) ==========

export const listCapsuleTypesReal: ListCapsuleTypesContract = async (input) => {
  const qs = new URLSearchParams();
  if (input?.category) qs.set('category', input.category);
  const query = qs.toString();
  return await apiRequest<{ items: CapsuleTypeMeta[]; categories: CapsuleCategoryInfo[] }>(
    api.workflowAgent.capsules.types() + (query ? `?${query}` : ''),
    { method: 'GET' }
  );
};

export const getCapsuleTypeReal: GetCapsuleTypeContract = async (typeKey) => {
  return await apiRequest<{ capsuleType: CapsuleTypeMeta }>(
    api.workflowAgent.capsules.typeByKey(typeKey),
    { method: 'GET' }
  );
};

export const testRunCapsuleReal: TestRunCapsuleContract = async (input) => {
  return await apiRequest<{ result: CapsuleTestRunResult }>(
    api.workflowAgent.capsules.testRun(),
    { method: 'POST', body: input }
  );
};

// ========== Chat Assistant (SSE) ==========

export const getChatHistoryReal: GetChatHistoryContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.afterSeq !== undefined) qs.set('afterSeq', String(input.afterSeq));
  const query = qs.toString();
  return await apiRequest<{ messages: WorkflowChatMessage[] }>(
    api.workflowAgent.chat.history(input.workflowId) + (query ? `?${query}` : ''),
    { method: 'GET' }
  );
};

/** Returns raw Response for SSE streaming */
export const chatWorkflowReal: ChatWorkflowContract = async (input) => {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '';
  const token = useAuthStore.getState().token;
  const res = await fetch(`${baseUrl}${api.workflowAgent.chat.fromChat()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  });
  return res;
};

/** Returns raw Response for SSE streaming */
export const analyzeExecutionReal: AnalyzeExecutionContract = async (input) => {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '';
  const token = useAuthStore.getState().token;
  const res = await fetch(`${baseUrl}${api.workflowAgent.chat.analyze(input.executionId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ instruction: input.instruction }),
  });
  return res;
};
