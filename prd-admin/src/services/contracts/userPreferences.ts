import type { ApiResponse } from '@/types/api';
import type { ThemeConfig } from '@/types/theme';

/** 后端返回的主题配置（可选字段，兼容旧数据） */
export type ThemeConfigResponse = {
  version?: number;
  colorDepth?: string;
  opacity?: string;
  enableGlow?: boolean;
  sidebarGlass?: string;
};

export type UserPreferences = {
  navOrder: string[];
  themeConfig?: ThemeConfigResponse;
};

export type GetUserPreferencesContract = () => Promise<ApiResponse<UserPreferences>>;

export type UpdateNavOrderContract = (navOrder: string[]) => Promise<ApiResponse<void>>;

export type UpdateThemeConfigContract = (themeConfig: ThemeConfig) => Promise<ApiResponse<void>>;
