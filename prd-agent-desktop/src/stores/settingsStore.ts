import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

interface AppConfig {
  apiBaseUrl: string;
}

interface SettingsState {
  config: AppConfig | null;
  defaultApiUrl: string;
  isLoading: boolean;
  isModalOpen: boolean;
  
  loadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: null,
  defaultApiUrl: 'https://agentapi.759800.com',
  isLoading: false,
  isModalOpen: false,

  loadConfig: async () => {
    set({ isLoading: true });
    try {
      const [config, defaultUrl] = await Promise.all([
        invoke<AppConfig>('get_config'),
        invoke<string>('get_default_api_url'),
      ]);
      set({ config, defaultApiUrl: defaultUrl });
    } catch (err) {
      console.error('Failed to load config:', err);
      // 使用默认配置
      set({
        config: { apiBaseUrl: get().defaultApiUrl },
      });
    } finally {
      set({ isLoading: false });
    }
  },

  saveConfig: async (config: AppConfig) => {
    set({ isLoading: true });
    try {
      await invoke('save_config', { config });
      set({ config });
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

