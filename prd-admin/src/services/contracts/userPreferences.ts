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

/** 视觉代理偏好设置 */
export type VisualAgentPreferences = {
  /** 是否自动选择模型 */
  modelAuto: boolean;
  /** 用户手动选择的模型 ID（仅当 modelAuto=false 时有效） */
  modelId?: string;
};

export type UserPreferences = {
  navOrder: string[];
  themeConfig?: ThemeConfigResponse;
  visualAgentPreferences?: VisualAgentPreferences;
};

export type GetUserPreferencesContract = () => Promise<ApiResponse<UserPreferences>>;

export type UpdateNavOrderContract = (navOrder: string[]) => Promise<ApiResponse<void>>;

export type UpdateThemeConfigContract = (themeConfig: ThemeConfig) => Promise<ApiResponse<void>>;

export type UpdateVisualAgentPreferencesContract = (prefs: VisualAgentPreferences) => Promise<ApiResponse<void>>;
