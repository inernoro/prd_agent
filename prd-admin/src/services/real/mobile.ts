import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  GetMobileFeedContract,
  GetMobileStatsContract,
  GetMobileAssetsContract,
  FeedItem,
  MobileStats,
  MobileAssetsResponse,
} from '@/services/contracts/mobile';

export const getMobileFeedReal: GetMobileFeedContract = async (args) => {
  const params = new URLSearchParams();
  if (args?.limit) params.set('limit', String(args.limit));
  const qs = params.toString() ? `?${params}` : '';
  return await apiRequest<{ items: FeedItem[] }>(`${api.mobile.feed()}${qs}`, { method: 'GET' });
};

export const getMobileStatsReal: GetMobileStatsContract = async (args) => {
  const params = new URLSearchParams();
  if (args?.days) params.set('days', String(args.days));
  const qs = params.toString() ? `?${params}` : '';
  return await apiRequest<MobileStats>(`${api.mobile.stats()}${qs}`, { method: 'GET' });
};

export const getMobileAssetsReal: GetMobileAssetsContract = async (args) => {
  const params = new URLSearchParams();
  if (args?.category) params.set('category', args.category);
  if (args?.limit) params.set('limit', String(args.limit));
  if (args?.skip) params.set('skip', String(args.skip));
  const qs = params.toString() ? `?${params}` : '';
  return await apiRequest<MobileAssetsResponse>(`${api.mobile.assets()}${qs}`, { method: 'GET' });
};
