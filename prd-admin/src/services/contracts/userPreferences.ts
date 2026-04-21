import type { ApiResponse } from '@/types/api';
import type { ThemeConfig } from '@/types/theme';

/** 后端返回的主题配置（可选字段，兼容旧数据） */
export type ThemeConfigResponse = {
  version?: number;
  colorDepth?: string;
  opacity?: string;
  enableGlow?: boolean;
  sidebarGlass?: string;
  performanceMode?: string;
};

/** 视觉代理生成类型 */
export type VisualAgentGenerationType = 'all' | 'text2img' | 'img2img' | 'vision';

/** 快捷指令配置 */
export type QuickActionConfig = {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 提示词模板 */
  prompt: string;
  /** 图标名称（lucide-react 图标 key，可选） */
  icon?: string;
};

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
  /** 用户自定义快捷指令（最多 10 个） */
  quickActions?: QuickActionConfig[];
};

/** Agent Switcher 最近访问记录项（服务端同步版） */
export type AgentSwitcherRecentVisit = {
  id: string;
  agentKey: string;
  agentName: string;
  title: string;
  path: string;
  icon?: string;
  timestamp: number;
};

/** Agent Switcher / 命令面板偏好（云端同步） */
export type AgentSwitcherPreferences = {
  pinnedIds?: string[];
  recentVisits?: AgentSwitcherRecentVisit[];
  usageCounts?: Record<string, number>;
};

/** 文学创作 Agent 偏好设置 */
export type LiteraryAgentPreferences = {
  /** 用户选择的生图模型池 ID */
  imageModelId?: string;
  /** 用户选择的文生提示词（对话/标记生成）模型池 ID */
  chatModelId?: string;
  /** 配图锚点教程气泡是否已看过（点击"知道啦"后置 true，不再弹出） */
  anchorTutorialSeen?: boolean;
};

export type UserPreferences = {
  navOrder: string[];
  navHidden: string[];
  themeConfig?: ThemeConfigResponse;
  visualAgentPreferences?: VisualAgentPreferences;
  literaryAgentPreferences?: LiteraryAgentPreferences;
  agentSwitcherPreferences?: AgentSwitcherPreferences;
};

export type GetUserPreferencesContract = () => Promise<ApiResponse<UserPreferences>>;

export type UpdateNavOrderContract = (navOrder: string[]) => Promise<ApiResponse<void>>;

export type UpdateNavHiddenContract = (navHidden: string[]) => Promise<ApiResponse<void>>;

export type UpdateNavLayoutContract = (payload: {
  navOrder: string[];
  navHidden: string[];
}) => Promise<ApiResponse<void>>;

export type UpdateThemeConfigContract = (themeConfig: ThemeConfig) => Promise<ApiResponse<void>>;

export type UpdateVisualAgentPreferencesContract = (prefs: VisualAgentPreferences) => Promise<ApiResponse<void>>;

export type UpdateLiteraryAgentPreferencesContract = (prefs: LiteraryAgentPreferences) => Promise<ApiResponse<void>>;

export type UpdateAgentSwitcherPreferencesContract = (prefs: AgentSwitcherPreferences) => Promise<ApiResponse<void>>;
