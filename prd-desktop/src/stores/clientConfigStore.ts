import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import { isTauri } from '../lib/tauri';

interface PresetServer {
  label: string;
  url: string;
}

interface ClientConfig {
  version: number;
  defaultApiUrl: string;
  presetServers: PresetServer[];
}

interface ClientConfigState {
  /** 远程配置的默认 API 地址 */
  defaultApiUrl: string | null;
  /** 远程配置的预设服务器列表 */
  presetServers: PresetServer[] | null;
  /** 是否已尝试过拉取（无论成功失败） */
  isFetched: boolean;
  /** 从 GitHub Release 拉取客户端配置 */
  fetchClientConfig: () => Promise<void>;
}

export const useClientConfigStore = create<ClientConfigState>((set) => ({
  defaultApiUrl: null,
  presetServers: null,
  isFetched: false,

  fetchClientConfig: async () => {
    if (!isTauri()) {
      set({ isFetched: true });
      return;
    }
    try {
      const config = await invoke<ClientConfig>('fetch_client_config');
      set({
        defaultApiUrl: config.defaultApiUrl,
        presetServers: config.presetServers,
        isFetched: true,
      });
    } catch (err) {
      console.warn('[clientConfig] Failed to fetch remote config:', err);
      set({ isFetched: true });
    }
  },
}));
