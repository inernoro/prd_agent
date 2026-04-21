import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { ok, type ApiResponse } from '@/types/api';
import type { ThemeConfig } from '@/types/theme';
import type {
  UserPreferences,
  GetUserPreferencesContract,
  UpdateNavLayoutContract,
  UpdateThemeConfigContract,
  UpdateVisualAgentPreferencesContract,
  UpdateLiteraryAgentPreferencesContract,
  UpdateAgentSwitcherPreferencesContract,
  ThemeConfigResponse,
  VisualAgentPreferences,
  LiteraryAgentPreferences,
  AgentSwitcherPreferences,
} from '@/services/contracts/userPreferences';

// 去重：navOrderStore + themeStore + VisualAgentTab 可能同时调用，共享一个 in-flight 请求
let inflightPrefs: Promise<ApiResponse<UserPreferences>> | null = null;

export const getUserPreferencesReal: GetUserPreferencesContract = async (): Promise<ApiResponse<UserPreferences>> => {
  if (inflightPrefs) return inflightPrefs;
  inflightPrefs = doGetUserPreferences();
  try {
    return await inflightPrefs;
  } finally {
    inflightPrefs = null;
  }
};

async function doGetUserPreferences(): Promise<ApiResponse<UserPreferences>> {
  const res = await apiRequest<{ navOrder: string[]; navHidden: string[]; themeConfig?: ThemeConfigResponse; visualAgentPreferences?: VisualAgentPreferences; literaryAgentPreferences?: LiteraryAgentPreferences; agentSwitcherPreferences?: AgentSwitcherPreferences }>(
    api.dashboard.userPreferences.get()
  );
  if (!res.success) return res as unknown as ApiResponse<UserPreferences>;
  return ok({
    navOrder: res.data.navOrder ?? [],
    navHidden: res.data.navHidden ?? [],
    themeConfig: res.data.themeConfig,
    visualAgentPreferences: res.data.visualAgentPreferences,
    literaryAgentPreferences: res.data.literaryAgentPreferences,
    agentSwitcherPreferences: res.data.agentSwitcherPreferences,
  });
}

export const updateNavLayoutReal: UpdateNavLayoutContract = async (payload): Promise<ApiResponse<void>> => {
  const res = await apiRequest<void>(api.dashboard.userPreferences.navLayout(), {
    method: 'PUT',
    body: { navOrder: payload.navOrder, navHidden: payload.navHidden },
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

export const updateVisualAgentPreferencesReal: UpdateVisualAgentPreferencesContract = async (
  prefs: VisualAgentPreferences
): Promise<ApiResponse<void>> => {
  const res = await apiRequest<void>(api.dashboard.userPreferences.visualAgent(), {
    method: 'PUT',
    body: { visualAgentPreferences: prefs },
  });
  if (!res.success) return res;
  return ok(undefined);
};

export const updateLiteraryAgentPreferencesReal: UpdateLiteraryAgentPreferencesContract = async (
  prefs: LiteraryAgentPreferences
): Promise<ApiResponse<void>> => {
  const res = await apiRequest<void>(api.dashboard.userPreferences.literaryAgent(), {
    method: 'PUT',
    body: { literaryAgentPreferences: prefs },
  });
  if (!res.success) return res;
  return ok(undefined);
};

export const updateAgentSwitcherPreferencesReal: UpdateAgentSwitcherPreferencesContract = async (
  prefs: AgentSwitcherPreferences
): Promise<ApiResponse<void>> => {
  const res = await apiRequest<void>(api.dashboard.userPreferences.agentSwitcher(), {
    method: 'PUT',
    body: { agentSwitcherPreferences: prefs },
  });
  if (!res.success) return res;
  return ok(undefined);
};
