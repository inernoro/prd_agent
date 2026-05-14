import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import { apiRequest } from './apiClient';

export interface InfraAgentSessionView {
  id: string;
  userId: string;
  connectionId: string;
  partner: string;
  cdsProjectId: string;
  cdsSessionId?: string | null;
  cdsWorkerId?: string | null;
  cdsContainerName?: string | null;
  traceId: string;
  runtimeProfileId?: string | null;
  modelBaseUrl?: string | null;
  runtime: string;
  model?: string | null;
  toolPolicy: string;
  hookProfileId?: string | null;
  title: string;
  status: string;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
}

export interface InfraAgentEventView {
  id: string;
  sessionId: string;
  seq: number;
  traceId: string;
  type: string;
  payloadJson: string;
  createdAt: string;
}

export interface InfraAgentHookProfileView {
  id: string;
  userId: string;
  name: string;
  beforeStart?: string | null;
  afterStart?: string | null;
  beforeStop?: string | null;
  afterStop?: string | null;
  failurePolicy: string;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface InfraAgentRuntimeProfileView {
  id: string;
  name: string;
  runtime: string;
  protocol: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InfraAgentRuntimeProfileTestResult {
  id: string;
  success: boolean;
  status: string;
  message: string;
  protocol: string;
  baseUrl: string;
  model: string;
  httpStatus?: number | null;
  elapsedMs: number;
}

interface ListResp {
  items: InfraAgentSessionView[];
}

interface ItemResp {
  item: InfraAgentSessionView;
}

interface EventsResp {
  items: InfraAgentEventView[];
}

interface LogsResp {
  logs: string;
}

interface HookProfilesResp {
  items: InfraAgentHookProfileView[];
}

interface HookProfileResp {
  item: InfraAgentHookProfileView;
}

interface RuntimeProfilesResp {
  items: InfraAgentRuntimeProfileView[];
}

interface RuntimeProfileResp {
  item: InfraAgentRuntimeProfileView;
}

interface RuntimeProfileTestResp {
  result: InfraAgentRuntimeProfileTestResult;
}

export async function listInfraAgentSessions(limit = 50): Promise<ApiResponse<ListResp>> {
  return await apiRequest<ListResp>(`${api.infraAgentSessions.list()}?limit=${limit}`, { method: 'GET' });
}

export async function createInfraAgentSession(input: {
  connectionId: string;
  runtime?: string;
  model?: string;
  runtimeProfileId?: string;
  title?: string;
  toolPolicy?: string;
  hookProfileId?: string;
}): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.create(), {
    method: 'POST',
    body: input,
  });
}

export async function startInfraAgentSession(id: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.start(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}

export async function sendInfraAgentMessage(id: string, content: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.messages(encodeURIComponent(id)), {
    method: 'POST',
    body: { content },
  });
}

export async function stopInfraAgentSession(id: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.stop(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}

export async function listInfraAgentEvents(
  id: string,
  afterSeq = 0,
  limit = 200,
): Promise<ApiResponse<EventsResp>> {
  return await apiRequest<EventsResp>(
    `${api.infraAgentSessions.events(encodeURIComponent(id))}?afterSeq=${afterSeq}&limit=${limit}`,
    { method: 'GET' },
  );
}

export async function getInfraAgentLogs(id: string): Promise<ApiResponse<LogsResp>> {
  return await apiRequest<LogsResp>(api.infraAgentSessions.logs(encodeURIComponent(id)), { method: 'GET' });
}

export async function approveInfraAgentTool(
  id: string,
  approvalId: string,
  decision: 'allow' | 'deny',
): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(
    api.infraAgentSessions.toolApproval(encodeURIComponent(id), encodeURIComponent(approvalId)),
    {
      method: 'POST',
      body: { decision },
    },
  );
}

export async function listInfraAgentHookProfiles(): Promise<ApiResponse<HookProfilesResp>> {
  return await apiRequest<HookProfilesResp>(api.infraAgentHookProfiles.list(), { method: 'GET' });
}

export async function createInfraAgentHookProfile(input: {
  name?: string;
  beforeStart?: string;
  afterStart?: string;
  beforeStop?: string;
  afterStop?: string;
  failurePolicy?: string;
  timeoutSeconds?: number;
}): Promise<ApiResponse<HookProfileResp>> {
  return await apiRequest<HookProfileResp>(api.infraAgentHookProfiles.create(), {
    method: 'POST',
    body: input,
  });
}

export async function listInfraAgentRuntimeProfiles(): Promise<ApiResponse<RuntimeProfilesResp>> {
  return await apiRequest<RuntimeProfilesResp>(api.infraAgentRuntimeProfiles.list(), { method: 'GET' });
}

export async function createInfraAgentRuntimeProfile(input: {
  name?: string;
  runtime?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  isDefault?: boolean;
}): Promise<ApiResponse<RuntimeProfileResp>> {
  return await apiRequest<RuntimeProfileResp>(api.infraAgentRuntimeProfiles.create(), {
    method: 'POST',
    body: input,
  });
}

export async function testInfraAgentRuntimeProfile(id: string): Promise<ApiResponse<RuntimeProfileTestResp>> {
  return await apiRequest<RuntimeProfileTestResp>(api.infraAgentRuntimeProfiles.test(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}
