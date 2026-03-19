import { create } from 'zustand';
import { isTauri } from '../lib/tauri';

type UpdatePhase =
  | 'idle'        // 无更新活动
  | 'checking'    // 正在检查
  | 'downloading' // 静默下载中
  | 'ready'       // 下载完成，等待用户确认安装
  | 'installing'  // 用户点击安装
  | 'error';      // 出错

interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  downloadProgress: number;
  error: string | null;
  /** 用户本次运行是否已关闭了更新通知 */
  isDismissed: boolean;
  /** 缓存的 Tauri Update 对象 */
  _updateObject: any | null;

  /** 静默检查并下载更新 */
  checkAndDownload: () => Promise<void>;
  /** 安装已下载的更新（触发重启） */
  installUpdate: () => Promise<void>;
  /** 关闭通知（本次运行内不再显示） */
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: 'idle',
  version: null,
  notes: null,
  downloadProgress: 0,
  error: null,
  isDismissed: false,
  _updateObject: null,

  checkAndDownload: async () => {
    const { phase } = get();
    // 防重入：非 idle/error 时跳过
    if (phase !== 'idle' && phase !== 'error') return;
    if (!isTauri()) return;

    set({ phase: 'checking', error: null });

    try {
      // 动态导入避免非 Tauri 环境报错
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (!update?.available) {
        set({ phase: 'idle' });
        return;
      }

      set({
        phase: 'downloading',
        version: update.version ?? null,
        notes: (update as any).body ?? null,
        downloadProgress: 0,
      });

      // 分步下载：download() 下载到磁盘，后续 install() 安装
      if (typeof update.download === 'function') {
        let lastPct = 0;
        await update.download((event: any) => {
          if (event?.event === 'Started' && event.data?.contentLength) {
            // 开始下载
          } else if (event?.event === 'Progress' && event.data?.chunkLength) {
            // 增量进度（Tauri 不直接给百分比，仅 chunkLength）
            // 简单递增避免回退
            lastPct = Math.min(lastPct + 1, 99);
            set({ downloadProgress: lastPct });
          } else if (event?.event === 'Finished') {
            set({ downloadProgress: 100 });
          }
        });

        set({
          phase: 'ready',
          downloadProgress: 100,
          isDismissed: false,
          _updateObject: update,
        });
      } else if (typeof update.downloadAndInstall === 'function') {
        // 降级：旧版 API 不支持分步，缓存对象后让用户点击时 downloadAndInstall
        set({
          phase: 'ready',
          downloadProgress: 100,
          isDismissed: false,
          _updateObject: update,
        });
      } else {
        set({ phase: 'error', error: 'Updater API 不支持下载' });
      }
    } catch (e) {
      console.warn('[updateStore] checkAndDownload failed:', e);
      set({ phase: 'error', error: String(e) });
    }
  },

  installUpdate: async () => {
    const { _updateObject } = get();
    if (!_updateObject) return;

    set({ phase: 'installing' });

    try {
      if (typeof _updateObject.install === 'function') {
        await _updateObject.install();
      } else if (typeof _updateObject.downloadAndInstall === 'function') {
        await _updateObject.downloadAndInstall();
      }
      // 正常情况下应用会自动重启，不会执行到这里
    } catch (e) {
      console.error('[updateStore] install failed:', e);
      set({ phase: 'error', error: String(e) });
    }
  },

  dismiss: () => {
    set({ isDismissed: true });
  },
}));
