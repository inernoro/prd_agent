import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { invoke } from '../../lib/tauri';
import { isTauri } from '../../lib/tauri';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useRemoteAssetsStore } from '../../stores/remoteAssetsStore';
import { useDesktopBrandingStore } from '../../stores/desktopBrandingStore';

interface ApiTestResult {
  success: boolean;
  latencyMs: number | null;
  error: string | null;
  serverStatus: string | null;
}

const DEFAULT_API_URL_NON_DEV = 'https://pa.759800.com';
const DEFAULT_API_URL_DEV = 'http://localhost:5000';
const DEFAULT_ASSETS_URL = ''; // 默认为空（不写死旧域名），等待后端配置下发或用户手动输入

function getDefaultApiUrl(isDeveloper: boolean) {
  return isDeveloper ? DEFAULT_API_URL_DEV : DEFAULT_API_URL_NON_DEV;
}

function byteLen(s: string): number {
  try {
    return new TextEncoder().encode(s).byteLength;
  } catch {
    // fallback: rough estimate (UTF-16 code units)
    return (s?.length ?? 0) * 2;
  }
}

function estimateStorageBytes(storage: Storage): number {
  let total = 0;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (!k) continue;
      const v = storage.getItem(k) ?? '';
      total += byteLen(k) + byteLen(v);
    }
  } catch {
    // ignore
  }
  return total;
}

function formatBytes(bytes: number): string {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

export default function SettingsModal() {
  const { config, isLoading, isModalOpen, closeModal, saveConfig, loadConfig } = useSettingsStore();
  const logout = useAuthStore((s) => s.logout);
  const clearSession = useSessionStore((s) => s.clearSession);
  const clearGroups = useGroupListStore((s) => s.clear);
  const clearMessages = useMessageStore((s) => s.clearMessages);
  const resetAssets = useRemoteAssetsStore((s) => s.resetLocalCacheAndRefresh);
  const refreshBranding = useDesktopBrandingStore((s) => s.refresh);
  const resetBranding = useDesktopBrandingStore((s) => s.resetToLocal);
  const [apiUrl, setApiUrl] = useState('');
  const [assetsUrl, setAssetsUrl] = useState('');
  const [error, setError] = useState('');
  const [isDeveloper, setIsDeveloper] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearConfirmStep, setClearConfirmStep] = useState<0 | 1 | 2>(0);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [cacheNote, setCacheNote] = useState<string>('');

  // 版本/更新
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'no-update' | 'installing' | 'error'>(
    'idle'
  );
  const [updateInfo, setUpdateInfo] = useState<{ version?: string; notes?: string } | null>(null);
  const [updateError, setUpdateError] = useState<string>('');
  
  // API 测试状态
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ApiTestResult | null>(null);

  useEffect(() => {
    if (isModalOpen) {
      loadConfig();
      setTestResult(null);
      setUpdateStatus('idle');
      setUpdateInfo(null);
      setUpdateError('');
      setClearConfirmStep(0);
      setCacheBytes(null);
      setCacheNote('');

      if (!isTauri()) {
        setAppVersion('');
      } else {
        getVersion()
          .then((v) => setAppVersion(v))
          .catch(() => setAppVersion(''));
      }
    }
  }, [isModalOpen, loadConfig]);

  useEffect(() => {
    if (!isModalOpen) return;

    const run = async () => {
      // 浏览器存储（localStorage/sessionStorage）
      const browserBytes = estimateStorageBytes(localStorage) + estimateStorageBytes(sessionStorage);

      // 本机落盘文件（preview_ask_history.json）
      let historyBytes = 0;
      try {
        const resp = await invoke<{ exists: boolean; bytes: number }>('get_preview_ask_history_stats');
        historyBytes = typeof resp?.bytes === 'number' ? Math.max(0, resp.bytes) : 0;
      } catch {
        // ignore
      }

      const total = browserBytes + historyBytes;
      setCacheBytes(total);
      setCacheNote(historyBytes > 0 ? `（含本章提问历史 ${formatBytes(historyBytes)}）` : '');
    };

    void run();
  }, [isModalOpen]);

  useEffect(() => {
    if (config) {
      const dev = import.meta.env.DEV ? Boolean(config.isDeveloper) : false;
      setIsDeveloper(dev);
      const cfgApi = String(config.apiBaseUrl || '').trim();
      setApiUrl(cfgApi || getDefaultApiUrl(dev));

      const cfgAssets = (config.assetsBaseUrl || '').trim();
      setAssetsUrl(cfgAssets || DEFAULT_ASSETS_URL);
    }
  }, [config]);

  const handleSave = async () => {
    setError('');
    
    const urlToSave = apiUrl.trim();
    const assetsToSave = assetsUrl.trim();
    
    // 验证 URL 格式
    if (!urlToSave) {
      setError('API 地址不能为空');
      return;
    }
    
    try {
      new URL(urlToSave);
    } catch {
      setError('请输入有效的 URL 地址');
      return;
    }

    if (!assetsToSave) {
      setError('资源地址不能为空');
      return;
    }
    try {
      new URL(assetsToSave);
    } catch {
      setError('请输入有效的资源 URL 地址');
      return;
    }
    
    try {
      await saveConfig({ apiBaseUrl: urlToSave, assetsBaseUrl: assetsToSave, isDeveloper });
      // 资源域名切换后：清空本地缓存并重新获取 skins/etag（不影响登录态）
      void resetAssets();
      // 切换服务地址/资源域名后，刷新一次 Desktop 品牌配置（在线模式）
      void refreshBranding('save');
      closeModal();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeveloperChange = (checked: boolean) => {
    setIsDeveloper(checked);
    // 仅影响“默认值”，输入框始终可编辑：
    // - 切到开发者：若当前还是线上默认（或空），则切到 localhost:5000
    // - 退出开发者：若当前是 localhost:5000，则切回线上默认
    const trimmed = apiUrl.trim();
    if (checked) {
      if (!trimmed || trimmed === DEFAULT_API_URL_NON_DEV) setApiUrl(DEFAULT_API_URL_DEV);
    } else {
      if (trimmed === DEFAULT_API_URL_DEV) setApiUrl(DEFAULT_API_URL_NON_DEV);
    }
    setTestResult(null);
    // 切换“本地/在线”后触发一次品牌配置刷新：
    // - 本地：回到内置品牌
    // - 在线：拉一次服务端配置
    if (checked) {
      resetBranding();
    } else {
      void refreshBranding('toggle');
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    setError('');

    const urlToTest = apiUrl.trim();

    if (!urlToTest) {
      setError('请先输入 API 地址');
      setIsTesting(false);
      return;
    }

    try {
      new URL(urlToTest);
    } catch {
      setError('请输入有效的 URL 地址');
      setIsTesting(false);
      return;
    }

    try {
      const result = await invoke<ApiTestResult>('test_api_connection', { apiUrl: urlToTest });
      setTestResult(result);
      if (result?.success) {
        void refreshBranding('test');
      }
    } catch (err) {
      setTestResult({
        success: false,
        latencyMs: null,
        error: String(err),
        serverStatus: null,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleCheckUpdate = async () => {
    setUpdateError('');
    setUpdateInfo(null);

    if (!isTauri()) {
      setUpdateStatus('error');
      setUpdateError('当前运行在非桌面(Tauri)环境，无法检查更新。');
      return;
    }

    setUpdateStatus('checking');
    try {
      const res: any = await checkUpdate();
      const available = Boolean(res?.available);
      if (!available) {
        setUpdateStatus('no-update');
        return;
      }
      setUpdateInfo({
        version: typeof res?.version === 'string' ? res.version : undefined,
        notes: typeof res?.body === 'string' ? res.body : typeof res?.notes === 'string' ? res.notes : undefined,
      });
      setUpdateStatus('available');
    } catch (e) {
      setUpdateStatus('error');
      setUpdateError(String(e));
    }
  };

  const handleDownloadAndInstall = async () => {
    setUpdateError('');
    if (!isTauri()) return;
    setUpdateStatus('installing');

    try {
      const res: any = await checkUpdate();
      const available = Boolean(res?.available);
      if (!available) {
        setUpdateStatus('no-update');
        return;
      }

      if (typeof res?.downloadAndInstall === 'function') {
        await res.downloadAndInstall();
      } else {
        throw new Error('Updater API 不支持 downloadAndInstall');
      }

      // 大多数情况下 updater 会自动重启；这里提供兜底提示
      setUpdateStatus('idle');
      setUpdateInfo(null);
      alert('更新已完成。如未自动重启，请手动关闭并重新打开应用。');
    } catch (e) {
      setUpdateStatus('error');
      setUpdateError(String(e));
    }
  };

  const handleOpenGithub = async () => {
    const url = 'https://github.com/inernoro/prd_agent';
    // Tauri 2：优先用 plugin-shell 打开外部链接；避免 window.open 无效
    if (isTauri()) {
      try {
        const mod = await import('@tauri-apps/plugin-shell');
        await mod.open(url);
        return;
      } catch {
        // fallback below
      }
    }

    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      alert(`请在浏览器中打开：${url}`);
    }
  };

  const handleCopyGithub = async () => {
    const url = 'https://github.com/inernoro/prd_agent';
    try {
      if (isTauri()) {
        const mod = await import('@tauri-apps/plugin-clipboard-manager');
        await mod.writeText(url);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        throw new Error('clipboard API 不可用');
      }
      alert('链接已复制');
    } catch {
      alert(`复制失败，请手动复制：${url}`);
    }
  };

  const handleStartClear = () => {
    if (isClearing) return;
    setClearConfirmStep(1);
  };

  const handleCancelClear = () => {
    if (isClearing) return;
    setClearConfirmStep(0);
  };

  const handleContinueClear = () => {
    if (isClearing) return;
    setClearConfirmStep(2);
  };

  const handleDoClearLocalCache = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      try {
        await invoke('clear_all_preview_ask_history');
      } catch {
        // ignore
      }

      try {
        clearMessages();
        clearSession();
        clearGroups();
      } catch {
        // ignore
      }

      try {
        // 先触发登出/清空 store（persist 可能会把“空状态”写回 localStorage）
        // 因此 localStorage 的最终清理必须放在 logout 之后，避免出现“清理后仍有少量 KB 占用”。
        logout();
      } catch {
        // ignore
      }

      // 最后清理浏览器存储，覆盖 persist 的写回
      try {
        localStorage.removeItem('auth-storage');
        localStorage.removeItem('session-storage');
        localStorage.removeItem('message-storage');
        localStorage.removeItem('prdAgent.sidebarWidth');
      } catch {
        // ignore
      }

      try {
        // no-op: legacy demo cache removed
      } catch {
        // ignore
      }

      try {
        closeModal();
      } catch {
        // ignore
      }
    } finally {
      setIsClearing(false);
      setClearConfirmStep(0);
    }
  };

  if (!isModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={closeModal}
      />
      
      {/* 模态框内容 */}
      <div className="relative w-full max-w-md mx-4 ui-glass-modal max-h-[90vh] overflow-y-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-black/10 dark:border-white/10 sticky top-0 ui-glass-bar z-10">
          <h2 className="text-lg font-semibold text-text-primary">设置</h2>
          <button
            onClick={closeModal}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        {/* 内容区域 */}
        <div className="p-6 space-y-5">
          {/* 版本与更新 */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-text-secondary">版本与更新</label>

            <div className="p-3 ui-glass-panel">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-text-secondary">当前版本</div>
                  <div className="text-sm text-text-primary font-mono break-all">
                    {appVersion ? appVersion : '-'}
                  </div>
                </div>
                <button
                  onClick={handleCheckUpdate}
                  disabled={updateStatus === 'checking' || updateStatus === 'installing'}
                  className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80"
                >
                  {updateStatus === 'checking' ? '检查中...' : '检查更新'}
                </button>
              </div>

              {updateStatus === 'no-update' && (
                <p className="mt-2 text-xs text-text-secondary">已是最新版本</p>
              )}

              {(updateStatus === 'available' || updateStatus === 'installing') && (
                <div className="mt-3 p-3 rounded-lg border border-cyan-500/25 bg-cyan-500/8">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-cyan-400">
                        {updateStatus === 'installing' ? '正在安装更新' : '发现新版本'}
                      </div>
                      <div className="text-sm text-text-primary font-mono break-all">
                        {updateInfo?.version || '新版本'}
                      </div>
                    </div>
                    <button
                      onClick={handleDownloadAndInstall}
                      disabled={updateStatus === 'installing'}
                      className="px-3 py-1.5 text-xs font-medium bg-cyan-500/30 hover:bg-cyan-500/40 text-white rounded-lg transition-colors disabled:opacity-50"
                    >
                      {updateStatus === 'installing' ? '安装中...' : '下载并安装'}
                    </button>
                  </div>
                  {updateInfo?.notes && (
                    <pre className="mt-2 text-xs text-text-secondary whitespace-pre-wrap break-words">
                      {updateInfo.notes}
                    </pre>
                  )}
                </div>
              )}

              {updateStatus === 'error' && updateError && (
                <div className="mt-3 p-3 rounded-lg border border-red-500/25 bg-red-500/8 text-red-700 dark:text-red-200 text-xs whitespace-pre-wrap break-words">
                  {updateError}
                </div>
              )}
            </div>
          </div>

          {/* 开发者选项：仅本地调试可见（发布版默认关闭且不提供入口） */}
          {import.meta.env.DEV && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-text-secondary">
                开发者选项
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={isDeveloper}
                    onChange={(e) => handleDeveloperChange(e.target.checked)}
                    className="sr-only"
                  />
                  <div className={`w-10 h-6 rounded-full transition-colors ${isDeveloper ? 'bg-cyan-500' : 'bg-black/10 dark:bg-white/20'}`}>
                    <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${isDeveloper ? 'translate-x-4' : ''}`} />
                  </div>
                </div>
                <span className="text-sm text-text-secondary">我是开发者（默认地址切换到本地）</span>
              </label>
            </div>
          )}

          {/* API 地址配置 */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-text-secondary">
              API 服务地址
            </label>

            {/* 地址输入框（始终可编辑） */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="block text-xs text-text-secondary">API 地址</label>
                <button
                  type="button"
                  onClick={() => {
                    setApiUrl(getDefaultApiUrl(isDeveloper));
                    setTestResult(null);
                  }}
                  className="px-2.5 py-1 text-xs font-medium bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-100 rounded-lg transition-colors"
                >
                  恢复默认
                </button>
              </div>
              <input
                type="url"
                value={apiUrl}
                onChange={(e) => {
                  setApiUrl(e.target.value);
                  setTestResult(null);
                }}
                placeholder={getDefaultApiUrl(isDeveloper)}
                className="w-full px-4 py-3 ui-control transition-colors"
              />
            </div>
          </div>

          {/* 资源地址配置 */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-text-secondary">
              资源地址（图标/皮肤）
            </label>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="block text-xs text-text-secondary">资源地址</label>
                <button
                  type="button"
                  onClick={() => {
                    setAssetsUrl(DEFAULT_ASSETS_URL);
                  }}
                  className="px-2.5 py-1 text-xs font-medium bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-100 rounded-lg transition-colors"
                >
                  恢复默认
                </button>
              </div>
              <input
                type="url"
                value={assetsUrl}
                onChange={(e) => setAssetsUrl(e.target.value)}
                placeholder={DEFAULT_ASSETS_URL}
                className="w-full px-4 py-3 ui-control transition-colors"
              />
              <div className="text-xs text-text-secondary">
                规则固定：会拼接为 <span className="font-mono">/icon/desktop/&lt;skin?&gt;/&lt;key&gt;</span>；Desktop 仅拉取皮肤列表，不从 API 获取地址规则。
              </div>
            </div>
          </div>

          {/* API 连接测试 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-text-secondary">
                连接测试
              </label>
              <button
                onClick={handleTestConnection}
                disabled={isTesting}
                className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5 dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80"
              >
                {isTesting ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    测试中...
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    测试连接
                  </>
                )}
              </button>
            </div>

            {/* 测试结果 */}
            {testResult && (
              <div className={`p-4 rounded-lg border ${testResult.success ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
                <div className="flex items-center gap-2 mb-2">
                  {testResult.success ? (
                    <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  <span className={`font-medium ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                    {testResult.success ? '连接成功' : '连接失败'}
                  </span>
                </div>
                
                <div className="space-y-1 text-sm">
                  {testResult.success && testResult.latencyMs !== null && (
                    <div className="flex items-center gap-2 text-text-secondary">
                      <span>延迟:</span>
                      <span className="font-mono text-green-400">{testResult.latencyMs}ms</span>
                    </div>
                  )}
                  {testResult.success && testResult.serverStatus && (
                    <div className="flex items-center gap-2 text-text-secondary">
                      <span>状态:</span>
                      <span className="font-mono text-green-400">{testResult.serverStatus}</span>
                    </div>
                  )}
                  {!testResult.success && testResult.error && (
                    <p className="text-red-700 dark:text-red-300">{testResult.error}</p>
                  )}
                </div>
              </div>
            )}

            {/* 未测试时的提示 */}
            {!testResult && !isTesting && (
              <p className="text-xs text-text-secondary">
                点击"测试连接"验证 API 服务是否可用
              </p>
            )}
          </div>
          
          {/* 错误提示 */}
          {error && (
            <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-200 text-sm">
              {error}
            </div>
          )}

          {/* 关于我们 */}
          <div className="space-y-3 pt-2">
            <label className="block text-sm font-medium text-text-secondary">关于我们</label>
            <div className="p-3 ui-glass-panel space-y-2">
              <div className="text-xs text-text-secondary">项目主页</div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={handleCopyGithub}
                  className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80"
                >
                  复制链接
                </button>
                <button
                  onClick={handleOpenGithub}
                  className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80"
                >
                  打开
                </button>
              </div>
              <p className="text-xs text-text-secondary">
                若系统限制无法自动打开，请复制链接到浏览器访问。
              </p>
            </div>
          </div>

          {/* 本地缓存 */}
          <div className="space-y-3 pt-2">
            <label className="block text-sm font-medium text-text-secondary">本地缓存</label>
            <div className="p-3 ui-glass-panel space-y-2">
              <div className="text-xs text-text-secondary">清理本机缓存与对话记录</div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-text-secondary">
                    将退出登录，并清空本机缓存（不影响服务器端数据）。
                  </p>
                  <div className="mt-1 text-xs text-text-secondary">
                    本机缓存：{cacheBytes === null ? '计算中...' : formatBytes(cacheBytes)}{cacheNote}
                  </div>
                </div>
                <button
                  onClick={handleStartClear}
                  disabled={isClearing}
                  className="px-3 py-1.5 text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-100 rounded-lg transition-colors disabled:opacity-50"
                >
                  {isClearing ? '清理中...' : '清除'}
                </button>
              </div>

              {clearConfirmStep > 0 && (
                <div className="mt-2 p-3 rounded-lg border border-red-500/25 bg-red-500/8">
                  <div className="text-xs text-red-100">
                    {clearConfirmStep === 1
                      ? '确认清理本机缓存？这会退出登录，并清空本机缓存与对话记录（不影响服务器端数据）。'
                      : '再次确认：清理后不可恢复。是否继续？'}
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={handleCancelClear}
                      disabled={isClearing}
                      className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80"
                    >
                      取消
                    </button>
                    {clearConfirmStep === 1 ? (
                      <button
                        type="button"
                        onClick={handleContinueClear}
                        disabled={isClearing}
                        className="px-3 py-1.5 text-xs font-medium bg-red-500/25 hover:bg-red-500/35 text-red-50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        继续
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleDoClearLocalCache}
                        disabled={isClearing}
                        className="px-3 py-1.5 text-xs font-medium bg-red-500/30 hover:bg-red-500/40 text-red-50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        确认清理
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        
        {/* 操作按钮 */}
        <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10 sticky bottom-0 ui-glass-bar">
          <button
            onClick={closeModal}
            className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={isLoading}
            className="flex-1 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isLoading ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

