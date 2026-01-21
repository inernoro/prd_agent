import { apiRequest } from '@/services/real/apiClient';
import { ok, type ApiResponse } from '@/types/api';
import type {
  GetGlobalRateLimitContract,
  UpdateGlobalRateLimitContract,
  GetUserRateLimitContract,
  UpdateUserRateLimitContract,
  GetExemptUsersContract,
  GetCustomConfigsContract,
  GlobalRateLimitConfig,
  UserRateLimitConfig,
  ExemptUserItem,
  CustomConfigItem,
} from '@/services/contracts/rateLimit';

const BASE_URL = '/api/v1/admin/rate-limit';

export const getGlobalRateLimitReal: GetGlobalRateLimitContract = async () => {
  const res = await apiRequest<GlobalRateLimitConfig>(`${BASE_URL}/global`);
  if (!res.success) return res;
  return ok(res.data);
};

export const updateGlobalRateLimitReal: UpdateGlobalRateLimitContract = async (
  maxRequestsPerMinute: number,
  maxConcurrentRequests: number
) => {
  const res = await apiRequest<GlobalRateLimitConfig>(`${BASE_URL}/global`, {
    method: 'PUT',
    body: { maxRequestsPerMinute, maxConcurrentRequests },
  });
  if (!res.success) return res;
  return ok(res.data);
};

export const getUserRateLimitReal: GetUserRateLimitContract = async (userId: string) => {
  const res = await apiRequest<UserRateLimitConfig>(`${BASE_URL}/users/${userId}`);
  if (!res.success) return res;
  return ok(res.data);
};

export const updateUserRateLimitReal: UpdateUserRateLimitContract = async (
  userId: string,
  data: {
    isExempt?: boolean;
    useCustomConfig?: boolean;
    maxRequestsPerMinute?: number;
    maxConcurrentRequests?: number;
  }
) => {
  const res = await apiRequest<UserRateLimitConfig>(`${BASE_URL}/users/${userId}`, {
    method: 'PUT',
    body: data,
  });
  if (!res.success) return res;
  return ok(res.data);
};

export const getExemptUsersReal: GetExemptUsersContract = async () => {
  const res = await apiRequest<{ items: ExemptUserItem[] }>(`${BASE_URL}/exempt-users`);
  if (!res.success) return res;
  return ok(res.data);
};

export const getCustomConfigsReal: GetCustomConfigsContract = async () => {
  const res = await apiRequest<{ items: CustomConfigItem[] }>(`${BASE_URL}/custom-configs`);
  if (!res.success) return res;
  return ok(res.data);
};
