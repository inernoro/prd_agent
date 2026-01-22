import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { ok, type ApiResponse } from '@/types/api';
import type { ThemeConfig } from '@/types/theme';
import type {
  UserPreferences,
  GetUserPreferencesContract,
  UpdateNavOrderContract,
  UpdateThemeConfigContract,
  ThemeConfigResponse,
} from '@/services/contracts/userPreferences';

export const getUserPreferencesReal: GetUserPreferencesContract = async (): Promise<ApiResponse<UserPreferences>> => {
  const res = await apiRequest<{ navOrder: string[]; themeConfig?: ThemeConfigResponse }>(
    api.dashboard.userPreferences.get()
  );
  if (!res.success) return res as unknown as ApiResponse<UserPreferences>;
  return ok({
    navOrder: res.data.navOrder ?? [],
    themeConfig: res.data.themeConfig,
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

export const updateThemeConfigReal: UpdateThemeConfigContract = async (
  themeConfig: ThemeConfig
): Promise<ApiResponse<void>> => {
  const res = await apiRequest<void>(api.dashboard.userPreferences.theme(), {
    method: 'PUT',
    body: { themeConfig },
  });
  if (!res.success) return res;
  return ok(undefined);
};
