import type { ApiResponse } from '@/types/api';

export type UserPreferences = {
  navOrder: string[];
};

export type GetUserPreferencesContract = () => Promise<ApiResponse<UserPreferences>>;

export type UpdateNavOrderContract = (navOrder: string[]) => Promise<ApiResponse<void>>;
