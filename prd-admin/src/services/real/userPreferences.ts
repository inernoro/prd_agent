import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { ok, type ApiResponse } from '@/types/api';
import type { UserPreferences, GetUserPreferencesContract, UpdateNavOrderContract } from '@/services/contracts/userPreferences';

export const getUserPreferencesReal: GetUserPreferencesContract = async (): Promise<ApiResponse<UserPreferences>> => {
  const res = await apiRequest<{ navOrder: string[] }>(api.dashboard.userPreferences.get());
  if (!res.success) return res as unknown as ApiResponse<UserPreferences>;
  return ok({
    navOrder: res.data.navOrder ?? [],
  });
};

export const updateNavOrderReal: UpdateNavOrderContract = async (navOrder: string[]): Promise<ApiResponse<void>> => {
  const res = await apiRequest<void>(api.dashboard.userPreferences.navOrder(), {
    method: 'PUT',
    body: { navOrder },
  });
  if (!res.success) return res;
  return ok(undefined);
};
