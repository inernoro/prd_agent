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

/** 视觉代理生成类型 */
export type VisualAgentGenerationType = 'all' | 'text2img' | 'img2img' | 'vision';

/** 视觉代理偏好设置 */
export type VisualAgentPreferences = {
  /** 是否自动选择模型 */
  modelAuto: boolean;
  /** 用户手动选择的模型 ID（仅当 modelAuto=false 时有效） */
  modelId?: string;
  /** 生成类型筛选（默认 'all' 显示所有类型的模型） */
  generationType?: VisualAgentGenerationType;
  /** 是否启用直连模式（跳过 prompt 解析） */
  directPrompt?: boolean;
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
