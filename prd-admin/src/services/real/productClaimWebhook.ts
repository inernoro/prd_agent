import { apiRequest } from './apiClient';

export interface ClaimWebhookConfig {
  enabled: boolean; debugMode: boolean; notifyInternal: boolean; notifyFormal: boolean;
  configured: boolean; maskedUrl?: string; canSend: boolean;
  identityReadyCount: number; identityPendingCount: number;
}
export interface ClaimNoticeRow {
  kind: 'T' | 'V'; id: string; code: string; ownerName?: string;
  notification: { status: string; error?: string };
}
export const getClaimWebhook = () => apiRequest<ClaimWebhookConfig>('/api/product/claim-webhook');
export const saveClaimWebhook = (body: Pick<ClaimWebhookConfig, 'enabled' | 'notifyInternal' | 'notifyFormal'> & { url?: string; debugMode?: boolean }) =>
  apiRequest<{ saved: boolean }>('/api/product/claim-webhook', { method: 'PUT', body });
export const getClaimNotices = () => apiRequest<{ items: ClaimNoticeRow[] }>('/api/product/claim-webhook/notifications');
export const retryClaimNotice = (kind: string, id: string) => apiRequest<{ queued: boolean }>(`/api/product/claim-webhook/notifications/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/retry`, { method: 'POST' });
export const debugClaimNotice = (kind: string, id: string) => apiRequest<{ queued: boolean }>(`/api/product/claim-webhook/notifications/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/debug`, { method: 'POST' });
