import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import { useRemoteAssetsStore } from './remoteAssetsStore';

interface AppConfig {
  apiBaseUrl: string;
  assetsBaseUrl?: string;
  isDeveloper: boolean;
  clientId?: string;
}

interface SettingsState {
  config: AppConfig | null;
  isLoading: boolean;
  isModalOpen: boolean;
  
  loadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  config: null,
  isLoading: false,
  isModalOpen: false,

  loadConfig: async () => {
    set({ isLoading: true });
    try {
      const config = await invoke<AppConfig>('get_config');
      set({ config });
      // 同步资源域名到 remoteAssets（不影响 skins/key 规则；仅用于替换域名前缀）
      const assetsBaseUrl = (config?.assetsBaseUrl || '').trim();
      if (assetsBaseUrl) {
        useRemoteAssetsStore.getState().setBaseUrl(assetsBaseUrl);
      }
    } catch (err) {
      console.error('Failed to load config:', err);
      // 使用默认配置
      set({
        config: { apiBaseUrl: 'https://pa.759800.com', assetsBaseUrl: 'https://i.pa.759800.com', isDeveloper: false },
      });
      useRemoteAssetsStore.getState().setBaseUrl('https://i.pa.759800.com');
    } finally {
      set({ isLoading: false });
    }
  },

  saveConfig: async (config: AppConfig) => {
    set({ isLoading: true });
    try {
      // 兼容旧版：clientId 由后端兜底生成，但前端保存时尽量保留已有值，避免重复生成
      const prev = useSettingsStore.getState().config;
      const toSave: AppConfig = { ...prev, ...config };
      await invoke('save_config', { config: toSave });
      set({ config: toSave });
      const assetsBaseUrl = (toSave.assetsBaseUrl || '').trim();
      if (assetsBaseUrl) {
        useRemoteAssetsStore.getState().setBaseUrl(assetsBaseUrl);
      }
    } catch (err) {
      console.error('Failed to save config:', err);
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false }),
}));

