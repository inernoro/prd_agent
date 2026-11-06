import { apiRequest } from './apiClient';

export type NotificationFrequency = 'once' | 'daily' | 'weekly' | 'monthly';
export type ScheduledNotificationWebhookInput = { existingIndex: number } | { url: string }
  | { groupId: string; groupRevision: string };

export type ScheduledNotificationInput = {
  name: string;
  message: string;
  frequency: NotificationFrequency;
  time: string;
  date: string | null;
  day: number | null;
  enabled: boolean;
  mentionAll: boolean;
  webhooks?: ScheduledNotificationWebhookInput[];
  revision?: string;
  sourceTaskId?: string;
  sourceRevision?: string;
};

export type ScheduledNotification = Omit<ScheduledNotificationInput, 'webhooks' | 'revision' | 'sourceTaskId' | 'sourceRevision'> & {
  id: string;
  revision: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: 'sending' | 'sent' | 'failed' | 'unknown' | 'partial' | null;
  lastDelivery: { sent: number; failed: number; unknown: number } | null;
  webhookMasked: string;
  webhookConfigured: boolean;
  webhookCount?: number;
  webhookGroupNames?: (string | null)[] | null;
  canEdit: boolean;
  debugLastResult: 'sending' | 'sent' | 'failed' | 'unknown' | null;
  debugLastRunAt: string | null;
};

const endpoint = '/api/product/settings/scheduled-notifications';
const groupsEndpoint = `${endpoint}/groups`;

export type NotificationGroup = { id: string; name: string; revision: string; webhookMasked: string };

export const listNotificationGroups = (signal?: AbortSignal) =>
  apiRequest<{ items: NotificationGroup[] }>(groupsEndpoint, { signal, timeoutMs: 15_000 });

export const saveNotificationGroup = (body: { name: string; webhookUrl?: string; revision?: string }, id?: string) =>
  apiRequest<NotificationGroup>(id ? `${groupsEndpoint}/${encodeURIComponent(id)}` : groupsEndpoint, {
    method: id ? 'PUT' : 'POST', body, timeoutMs: 15_000,
  });

export const removeNotificationGroup = (group: NotificationGroup) =>
  apiRequest<{ id: string }>(`${groupsEndpoint}/${encodeURIComponent(group.id)}?revision=${encodeURIComponent(group.revision)}`, {
    method: 'DELETE', timeoutMs: 15_000,
  });

export const listScheduledNotifications = (signal?: AbortSignal) =>
  apiRequest<{ canManage: boolean; items: ScheduledNotification[] }>(endpoint, { signal });

export const saveScheduledNotification = (input: ScheduledNotificationInput, id?: string) =>
  apiRequest<ScheduledNotification>(id ? `${endpoint}/${encodeURIComponent(id)}` : endpoint, {
    method: id ? 'PUT' : 'POST',
    body: input,
    timeoutMs: 15_000,
  });

export type NotificationDebugSettings = { configured: boolean; webhookMasked: string | null; canManage: boolean };
export const getNotificationDebugSettings = (signal?: AbortSignal) =>
  apiRequest<NotificationDebugSettings>(`${endpoint}/debug-settings`, { signal });
export const saveNotificationDebugSettings = (webhookUrl: string) =>
  apiRequest<{ configured: boolean }>(`${endpoint}/debug-settings`, { method: 'PUT', body: { webhookUrl } });
export const debugScheduledNotification = (id: string, requestId: string) =>
  apiRequest<{ status: ScheduledNotification['debugLastResult'] }>(`${endpoint}/${encodeURIComponent(id)}/debug`, {
    method: 'POST', body: { requestId },
  });
