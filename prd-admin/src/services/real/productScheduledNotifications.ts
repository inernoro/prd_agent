import { apiRequest } from './apiClient';

export type NotificationFrequency = 'once' | 'daily' | 'weekly' | 'monthly';

export type ScheduledNotificationInput = {
  name: string;
  message: string;
  frequency: NotificationFrequency;
  time: string;
  date: string | null;
  day: number | null;
  enabled: boolean;
  webhookUrl?: string;
  revision?: string;
};

export type ScheduledNotification = Omit<ScheduledNotificationInput, 'webhookUrl' | 'revision'> & {
  id: string;
  revision: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: 'sending' | 'sent' | 'failed' | 'unknown' | null;
  webhookMasked: string;
};

const endpoint = '/api/product/settings/scheduled-notifications';

export const listScheduledNotifications = (signal?: AbortSignal) =>
  apiRequest<{ canManage: boolean; items: ScheduledNotification[] }>(endpoint, { signal });

export const saveScheduledNotification = (input: ScheduledNotificationInput, id?: string) =>
  apiRequest<ScheduledNotification>(id ? `${endpoint}/${encodeURIComponent(id)}` : endpoint, {
    method: id ? 'PUT' : 'POST',
    body: input,
  });
