import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { rawInvoke } from '../lib/tauri';

export type DesktopBranding = {
  desktopName: string;
  loginIconKey: string;
  updatedAt?: string | null;
  source: 'local' | 'server';
};

const DEFAULT_BRANDING: DesktopBranding = {
  desktopName: 'PRD Agent',
  loginIconKey: 'login_icon.png',
  updatedAt: null,
  source: 'local',
};

type BrandingState = {
  branding: DesktopBranding;
  lastFetchedAt: number | null;
  refresh: (reason?: string) => Promise<void>;
  resetToLocal: () => void;
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

      resetToLocal: () => set({ branding: { ...DEFAULT_BRANDING, source: 'local' } }),

      refresh: async (_reason) => {
        const now = Date.now();
        const last = get().lastFetchedAt;
        if (typeof last === 'number' && now - last < MIN_REFRESH_INTERVAL_MS) return;
        set({ lastFetchedAt: now });

        try {
          // Tauri command：本地模式返回 null；在线模式返回 server 下发配置
          const resp = await rawInvoke<{ desktopName: string; loginIconKey: string; updatedAt?: string | null } | null>(
            'fetch_desktop_branding'
          );
          if (!resp) {
            set({ branding: { ...DEFAULT_BRANDING, source: 'local' } });
            return;
          }
          const name = String(resp.desktopName || '').trim() || DEFAULT_BRANDING.desktopName;
          const key = String(resp.loginIconKey || '').trim().toLowerCase() || DEFAULT_BRANDING.loginIconKey;
          set({
            branding: {
              desktopName: name,
              loginIconKey: key,
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


