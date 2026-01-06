import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { rawInvoke } from '../lib/tauri';

export type DesktopBranding = {
  desktopName: string;
  desktopSubtitle: string;
  windowTitle: string;
  loginIconKey: string;
  loginBackgroundKey: string;
  loginIconUrl?: string | null;         // 完整 URL（后端已处理回退逻辑）
  loginBackgroundUrl?: string | null;   // 完整 URL（后端已处理回退逻辑）
  assets?: Record<string, string>;      // 所有资源的 key -> URL 映射（带回退逻辑）
  updatedAt?: string | null;
  source: 'local' | 'server';
};

const DEFAULT_BRANDING: DesktopBranding = {
  desktopName: 'PRD Agent',
  desktopSubtitle: '智能PRD解读助手',
  windowTitle: 'PRD Agent',
  loginIconKey: 'login_icon',        // 不含扩展名
  loginBackgroundKey: 'bg',           // 不含扩展名
  loginIconUrl: null,
  loginBackgroundUrl: null,
  assets: {},
  updatedAt: null,
  source: 'local',
};

type BrandingState = {
  branding: DesktopBranding;
  lastFetchedAt: number | null;
  lastFetchedSkin: string | null;
  refresh: (reason?: string, skin?: 'white' | 'dark' | null) => Promise<void>;
  resetToLocal: () => void;
  getAssetUrl: (key: string) => string | null;
};

const STORAGE_KEY = 'desktop-branding-storage';
const STORAGE_VERSION = 1;

// 防抖：避免“测试连接/切换/启动”短时间内重复拉取
const MIN_REFRESH_INTERVAL_MS = 2500;

export const useDesktopBrandingStore = create<BrandingState>()(
  persist(
    (set, get) => ({
      branding: DEFAULT_BRANDING,
      lastFetchedAt: null,
      lastFetchedSkin: null,

      resetToLocal: () => set({ branding: { ...DEFAULT_BRANDING, source: 'local' } }),

      getAssetUrl: (key: string) => {
        const { branding } = get();
        const k = String(key || '').trim().toLowerCase();
        if (!k) return null;
        return branding.assets?.[k] ?? null;
      },

      refresh: async (_reason, skin) => {
        const now = Date.now();
        const last = get().lastFetchedAt;
        const lastSkin = get().lastFetchedSkin;
        const currentSkin = skin || null;
        
        // 如果 skin 发生变化，强制刷新（不受防抖限制）
        const skinChanged = lastSkin !== currentSkin;
        
        // 防抖：避免短时间内重复拉取（除非 skin 变化）
        if (!skinChanged && typeof last === 'number' && now - last < MIN_REFRESH_INTERVAL_MS) return;
        
        set({ lastFetchedAt: now, lastFetchedSkin: currentSkin });

        try {
          // Tauri command：本地模式返回 null；在线模式返回 server 下发配置
          // skin: 'white' (浅色模式) | 'dark' (深色模式) | null (默认)
          const resp = await rawInvoke<{
            desktopName: string;
            desktopSubtitle?: string;
            windowTitle?: string;
            loginIconKey: string;
            loginBackgroundKey: string;
            loginIconUrl?: string | null;
            loginBackgroundUrl?: string | null;
            assets?: Record<string, string>;
            updatedAt?: string | null;
          } | null>(
            'fetch_desktop_branding',
            { skin: skin || null }
          );
          if (!resp) {
            set({ branding: { ...DEFAULT_BRANDING, source: 'local' } });
            return;
          }
          const name = String(resp.desktopName || '').trim() || DEFAULT_BRANDING.desktopName;
          const subtitle = String(resp.desktopSubtitle || '').trim() || DEFAULT_BRANDING.desktopSubtitle;
          const windowTitle = String(resp.windowTitle || '').trim() || name || DEFAULT_BRANDING.windowTitle;
          const key = String(resp.loginIconKey || '').trim().toLowerCase() || DEFAULT_BRANDING.loginIconKey;
          const bgKey = String(resp.loginBackgroundKey || '').trim().toLowerCase() || DEFAULT_BRANDING.loginBackgroundKey;
          set({
            branding: {
              desktopName: name,
              desktopSubtitle: subtitle,
              windowTitle,
              loginIconKey: key,
              loginBackgroundKey: bgKey,
              loginIconUrl: resp.loginIconUrl ?? null,
              loginBackgroundUrl: resp.loginBackgroundUrl ?? null,
              assets: resp.assets ?? {},
              updatedAt: resp.updatedAt ?? null,
              source: 'server',
            },
          });
        } catch {
          // best-effort：失败不打扰用户
        }
      },
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
    }
  )
);


