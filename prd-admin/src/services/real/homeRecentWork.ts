import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type { ListRecentWorkContract, RecentWorkItemDto } from '@/services/contracts/homeRecentWork';

export const listRecentWork: ListRecentWorkContract = async (input) => {
  const limit = Math.max(1, Math.min(30, input?.limit ?? 8));
  const query = new URLSearchParams({ limit: String(limit) });
  if (input?.webDeliveriesOnly) query.set('webDeliveriesOnly', 'true');
  return apiRequest<{ items: RecentWorkItemDto[] }>(`${api.home.recentWork()}?${query}`, { method: 'GET' });
};
