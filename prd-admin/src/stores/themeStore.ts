/**
 * 主题/皮肤配置 Store
 * 基于 Zustand + persist，参考 navOrderStore 模式
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getUserPreferences, updateThemeConfig } from '@/services';
import type { ThemeConfig, ColorDepthLevel, OpacityLevel, SidebarGlassMode, PerformanceMode } from '@/types/theme';
import { DEFAULT_THEME_CONFIG } from '@/types/theme';
import { applyThemeToDOM } from '@/lib/themeApplier';
import type { ThemeConfigResponse } from '@/services/contracts/userPreferences';

/**
 * 将后端返回的 string 类型转换为前端的枚举类型
 */
function parseThemeConfigResponse(response: ThemeConfigResponse): Partial<ThemeConfig> {
  const result: Partial<ThemeConfig> = {};

  if (response.version !== undefined) {
    result.version = response.version;
  }
  if (response.colorDepth && ['darker', 'default', 'lighter'].includes(response.colorDepth)) {
    result.colorDepth = response.colorDepth as ColorDepthLevel;
  }
  if (response.opacity && ['solid', 'default', 'translucent'].includes(response.opacity)) {
    result.opacity = response.opacity as OpacityLevel;
  }
  if (response.enableGlow !== undefined) {
    result.enableGlow = response.enableGlow;
  }
  if (response.sidebarGlass && ['auto', 'always', 'never'].includes(response.sidebarGlass)) {
    result.sidebarGlass = response.sidebarGlass as SidebarGlassMode;
  }
  if (response.performanceMode && ['auto', 'quality', 'performance'].includes(response.performanceMode)) {
    result.performanceMode = response.performanceMode as PerformanceMode;
  }

  return result;
}

type ThemeState = {
  /** 当前主题配置 */
  config: ThemeConfig;
  /** 是否已从后端加载 */
  loaded: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 从后端加载配置 */
  loadFromServer: () => Promise<void>;
  /** 更新配置（立即应用 + 防抖保存到后端） */
  setConfig: (partial: Partial<ThemeConfig>) => void;
  /** 重置为默认配置 */
  reset: () => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_THEME_CONFIG,
      loaded: false,
      saving: false,

      loadFromServer: async () => {
        try {
          const res = await getUserPreferences();
          if (res.success && res.data?.themeConfig) {
            // 合并后端配置与默认值（兼容新字段），转换 string 为枚举类型
            const parsedConfig = parseThemeConfigResponse(res.data.themeConfig);
            const serverConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, ...parsedConfig };
            const currentConfig = get().config;

            // 只在配置真正不同时才更新 DOM，避免闪烁
            const isDifferent =
              serverConfig.colorDepth !== currentConfig.colorDepth ||
              serverConfig.opacity !== currentConfig.opacity ||
              serverConfig.enableGlow !== currentConfig.enableGlow ||
              serverConfig.sidebarGlass !== currentConfig.sidebarGlass ||
              serverConfig.performanceMode !== currentConfig.performanceMode;

            if (isDifferent) {
              set({ config: serverConfig, loaded: true });
              applyThemeToDOM(serverConfig);
            } else {
              set({ loaded: true });
            }
          } else {
            // 后端没有配置，使用本地缓存或默认值，不需要重新应用 DOM
            set({ loaded: true });
          }
        } catch {
          // 加载失败，使用本地缓存或默认值
          set({ loaded: true });
        }
      },

      setConfig: (partial) => {
        const newConfig = { ...get().config, ...partial };
        set({ config: newConfig });

        // 立即应用到 DOM
        applyThemeToDOM(newConfig);

        // 防抖保存到后端
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          const state = get();
          if (state.saving) return;
          set({ saving: true });
          try {
            await updateThemeConfig(state.config);
          } catch {
            // 静默失败，本地配置仍然生效
          } finally {
            set({ saving: false });
          }
        }, 800);
      },

      reset: () => {
        if (saveTimer) clearTimeout(saveTimer);
        set({ config: DEFAULT_THEME_CONFIG, saving: false });
        applyThemeToDOM(DEFAULT_THEME_CONFIG);

        // 同步重置到后端
        updateThemeConfig(DEFAULT_THEME_CONFIG).catch(() => {
          // 静默失败
        });
      },
    }),
    {
      name: 'prd-admin-theme',
      // 本地缓存配置，避免每次刷新都等后端
      partialize: (s) => ({ config: s.config }),
    }
  )
);

/**
 * 初始化主题
 * 应在应用启动时调用，优先使用本地缓存，后台加载后端配置
 */
export function initializeTheme(): void {
  const state = useThemeStore.getState();

  // 立即应用本地缓存的配置
  applyThemeToDOM(state.config);

  // 后台加载后端配置（如果有差异会自动更新）
  state.loadFromServer();
}
