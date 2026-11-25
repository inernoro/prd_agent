import { api } from '@/services/api';
import type { QuickVideoInput, QuickVideoRun, QuickVideoSummary, QuickVideoTemplate } from '@/services/contracts/quickCreate';
import { apiRequest } from './apiClient';

export const listQuickVideoTemplatesReal = () =>
  apiRequest<{ items: QuickVideoTemplate[]; canGenerate: boolean; speechReady: boolean }>(api.quickCreate.templates(), { method: 'GET' });

export const createQuickVideoReal = (body: QuickVideoInput) =>
  apiRequest<{ runId: string }>(api.quickCreate.runs(), {
    method: 'POST', body, headers: { 'Idempotency-Key': body.templateRequestId },
  });

export const listQuickVideosReal = () => apiRequest<QuickVideoSummary[]>(api.quickCreate.runs(), { method: 'GET' });

export const getQuickVideoReal = (id: string) => apiRequest<QuickVideoRun>(api.quickCreate.run(id), { method: 'GET' });

export const publishQuickVideoReal = (id: string) =>
  apiRequest<{ siteId: string }>(api.quickCreate.publish(id), { method: 'POST' });
