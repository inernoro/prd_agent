import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { RecentWorkItemDto } from '@/services/contracts/homeRecentWork';

export async function listRecentWork(input?: { limit?: number }): Promise<ApiResponse<{ items: RecentWorkItemDto[] }>> {
  const limit = Math.max(1, Math.min(30, input?.limit ?? 8));
  return await apiRequest<{ items: RecentWorkItemDto[] }>(`${api.home.recentWork()}?limit=${limit}`, { method: 'GET' });
}
