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
  type: string;
  payloadJson: string;
  createdAt: string;
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

export async function listInfraAgentSessions(limit = 50): Promise<ApiResponse<ListResp>> {
  return await apiRequest<ListResp>(`${api.infraAgentSessions.list()}?limit=${limit}`, { method: 'GET' });
}

export async function createInfraAgentSession(input: {
  connectionId: string;
  runtime?: string;
  model?: string;
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
