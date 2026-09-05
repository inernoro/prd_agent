import type { AdminMenuItem } from '@/services/contracts/authz';
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
  /** 界面材质：solid 素色实底（默认）/ glass 液态玻璃 */
  material?: string;
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

export type HomeLauncherPreferences = {
  /** 首页第二张快捷卡：library=智识殿堂，voc=VOC */
  secondaryQuickLink?: 'library' | 'voc';
  /** 首页顶部资源卡列表，按顺序渲染，最多 6 个 */
  quickLinkIds?: string[];
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
  /** 服务端是否明确持有过导航布局（空数组 + true = 被主动清空，前端不得用本地缓存回填） */
  navLayoutSynced?: boolean;
  defaultNavOrder: string[];
  defaultNavHidden: string[];
  themeConfig?: ThemeConfigResponse;
  visualAgentPreferences?: VisualAgentPreferences;
  literaryAgentPreferences?: LiteraryAgentPreferences;
  agentSwitcherPreferences?: AgentSwitcherPreferences;
  homeLauncherPreferences?: HomeLauncherPreferences;
  /** 用户置顶的知识库 ID 列表（按用户视角排前） */
  documentStorePinnedIds?: string[];
};

export type GetUserPreferencesContract = () => Promise<ApiResponse<UserPreferences>>;

export type UpdateNavLayoutContract = (payload: {
  navOrder: string[];
  navHidden: string[];
}) => Promise<ApiResponse<void>>;

export type UpdateThemeConfigContract = (themeConfig: ThemeConfig) => Promise<ApiResponse<void>>;

export type UpdateVisualAgentPreferencesContract = (prefs: VisualAgentPreferences) => Promise<ApiResponse<void>>;

export type UpdateLiteraryAgentPreferencesContract = (prefs: LiteraryAgentPreferences) => Promise<ApiResponse<void>>;

export type UpdateAgentSwitcherPreferencesContract = (prefs: AgentSwitcherPreferences) => Promise<ApiResponse<void>>;

export type UpdateHomeLauncherPreferencesContract = (prefs: HomeLauncherPreferences) => Promise<ApiResponse<void>>;

export type DefaultNavLayout = {
  navOrder: string[];
  navHidden: string[];
  updatedAt?: string;
};

export type ApplyDefaultNavToAllUsersResult = {
  matchedCount: number;
  modifiedCount: number;
};

export type GetDefaultNavLayoutContract = () => Promise<ApiResponse<DefaultNavLayout>>;

export type UpdateDefaultNavLayoutContract = (payload: {
  navOrder: string[];
  navHidden: string[];
}) => Promise<ApiResponse<DefaultNavLayout>>;

export type ApplyDefaultNavToAllUsersContract = () => Promise<ApiResponse<ApplyDefaultNavToAllUsersResult>>;

/** 全员导航总览里的一行：一个真人用户 + 他当前生效的个人导航 */
export type UserNavLayoutItem = {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  /** navOrder 或 navHidden 任一非空即为自定义过 */
  customized: boolean;
  navOrder: string[];
  navHidden: string[];
  updatedAt?: string | null;
};

export type UserNavLayoutsResult = {
  items: UserNavLayoutItem[];
  totalCount: number;
  customizedCount: number;
  /** 全量菜单目录（服务端不按调用者权限过滤），总览用它判「已下线」与复演侧栏自动补齐 */
  catalog: AdminMenuItem[];
};

export type GetUserNavLayoutsContract = () => Promise<ApiResponse<UserNavLayoutsResult>>;

/** 清空某个用户的个人导航，让其回退到「所有人的默认导航」 */
export type ResetUserNavLayoutContract = (userId: string) => Promise<ApiResponse<UserNavLayoutItem>>;

export type RemoveNavTokensResult = {
  tokens: string[];
  defaultRemovedCount: number;
  defaultNavOrder: string[];
  defaultNavHidden: string[];
  usersMatchedCount: number;
  usersModifiedCount: number;
};

/** 从所有人的默认导航 + 全部用户的个人导航里拔掉指定 token（菜单下线后的清理），不重置任何人的顺序 */
export type RemoveNavTokensContract = (tokens: string[]) => Promise<ApiResponse<RemoveNavTokensResult>>;
