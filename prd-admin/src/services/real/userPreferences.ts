import { apiRequest } from '@/services/real/apiClient';
import { ok, type ApiResponse } from '@/types/api';
import type { UserPreferences, GetUserPreferencesContract, UpdateNavOrderContract } from '@/services/contracts/userPreferences';

export const getUserPreferencesReal: GetUserPreferencesContract = async (): Promise<ApiResponse<UserPreferences>> => {
  const res = await apiRequest<{ navOrder: string[] }>('/api/v1/admin/user-preferences');
  if (!res.success) return res as unknown as ApiResponse<UserPreferences>;
  return ok({
    navOrder: res.data.navOrder ?? [],
  });
};

export const updateNavOrderReal: UpdateNavOrderContract = async (navOrder: string[]): Promise<ApiResponse<void>> => {
  const res = await apiRequest<void>('/api/v1/admin/user-preferences/nav-order', {
    method: 'PUT',
    body: JSON.stringify({ navOrder }),
  });
  if (!res.success) return res;
  return ok(undefined);
};
