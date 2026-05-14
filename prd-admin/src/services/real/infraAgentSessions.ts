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
  isArchived: boolean;
  manualTakeoverEnabled: boolean;
  manualTakeoverAt?: string | null;
  manualTakeoverReason?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
}

export type InfraAgentEventType =
  | 'status'
  | 'text_delta'
  | 'tool_call'
  | 'tool_result'
  | 'log'
  | 'error'
  | 'done'
  | 'hook'
  | 'file'
  | 'diff'
  | 'browser'
  | 'manual';

export interface InfraAgentEventView {
  id: string;
  sessionId: string;
  seq: number;
  traceId: string;
  type: InfraAgentEventType | string;
  payloadJson: string;
  createdAt: string;
}

export interface InfraAgentEventSchemaItem {
  type: InfraAgentEventType;
  description: string;
  requiredPayloadFields: string[];
  optionalPayloadFields: string[];
}

export interface InfraAgentMessageView {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  status: string;
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

interface EventSchemaResp {
  items: InfraAgentEventSchemaItem[];
}

interface MessagesResp {
  items: InfraAgentMessageView[];
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

export async function getInfraAgentEventSchema(): Promise<ApiResponse<EventSchemaResp>> {
  return await apiRequest<EventSchemaResp>(api.infraAgentSessions.eventSchema(), { method: 'GET' });
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

export async function archiveInfraAgentSession(id: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.archive(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}

export async function collectInfraAgentArtifacts(id: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.collectArtifacts(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}

export async function runInfraAgentReadonlyChecks(id: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.runReadonlyChecks(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}

export async function setInfraAgentManualTakeover(
  id: string,
  enabled: boolean,
  reason?: string,
): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.manualTakeover(encodeURIComponent(id)), {
    method: 'POST',
    body: { enabled, reason },
  });
}

export async function addInfraAgentManualInput(id: string, content: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraAgentSessions.manualInputs(encodeURIComponent(id)), {
    method: 'POST',
    body: { content },
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

export async function listInfraAgentMessages(
  id: string,
  limit = 200,
): Promise<ApiResponse<MessagesResp>> {
  return await apiRequest<MessagesResp>(
    `${api.infraAgentSessions.messageList(encodeURIComponent(id))}?limit=${limit}`,
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

export async function updateInfraAgentRuntimeProfile(id: string, input: {
  name?: string;
  runtime?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  isDefault?: boolean;
}): Promise<ApiResponse<RuntimeProfileResp>> {
  return await apiRequest<RuntimeProfileResp>(api.infraAgentRuntimeProfiles.byId(encodeURIComponent(id)), {
    method: 'PUT',
    body: input,
  });
}

export async function importDefaultInfraAgentRuntimeProfile(): Promise<ApiResponse<RuntimeProfileResp>> {
  return await apiRequest<RuntimeProfileResp>(api.infraAgentRuntimeProfiles.importDefaultModel(), {
    method: 'POST',
    body: {},
  });
}

export async function testInfraAgentRuntimeProfile(id: string): Promise<ApiResponse<RuntimeProfileTestResp>> {
  return await apiRequest<RuntimeProfileTestResp>(api.infraAgentRuntimeProfiles.test(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}
