import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/settingsStore';

interface ApiTestResult {
  success: boolean;
  latencyMs: number | null;
  error: string | null;
  serverStatus: string | null;
}

export default function SettingsModal() {
  const { config, defaultApiUrl, isLoading, isModalOpen, closeModal, saveConfig, loadConfig } = useSettingsStore();
  const [apiUrl, setApiUrl] = useState('');
  const [error, setError] = useState('');
  const [useDefault, setUseDefault] = useState(true);
  
  // API 测试状态
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ApiTestResult | null>(null);

  useEffect(() => {
    if (isModalOpen) {
      loadConfig();
      setTestResult(null);
    }
  }, [isModalOpen, loadConfig]);

  useEffect(() => {
    if (config) {
      const isDefault = config.apiBaseUrl === defaultApiUrl;
      setUseDefault(isDefault);
      setApiUrl(config.apiBaseUrl);
    }
  }, [config, defaultApiUrl]);

  const handleSave = async () => {
    setError('');
    
    const urlToSave = useDefault ? defaultApiUrl : apiUrl.trim();
    
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
    
    try {
      await saveConfig({ apiBaseUrl: urlToSave });
      closeModal();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleUseDefaultChange = (checked: boolean) => {
    setUseDefault(checked);
    if (checked) {
      setApiUrl(defaultApiUrl);
    }
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    setError('');

    const urlToTest = useDefault ? defaultApiUrl : apiUrl.trim();

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

  if (!isModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={closeModal}
      />
      
      {/* 模态框内容 */}
      <div className="relative w-full max-w-md mx-4 bg-slate-800 rounded-2xl shadow-2xl border border-white/10 max-h-[90vh] overflow-y-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 sticky top-0 bg-slate-800 z-10">
          <h2 className="text-lg font-semibold text-white">设置</h2>
          <button
            onClick={closeModal}
            className="p-1 rounded-lg hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        {/* 内容区域 */}
        <div className="p-6 space-y-5">
          {/* API 地址配置 */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-white/80">
              API 服务地址
            </label>
            
            {/* 默认地址显示 */}
            <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-lg">
              <div className="flex items-center gap-2 mb-1">
                <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs font-medium text-cyan-400">默认服务器</span>
              </div>
              <p className="text-sm text-white/80 font-mono break-all">{defaultApiUrl}</p>
            </div>
            
            {/* 使用默认地址开关 */}
            <label className="flex items-center gap-3 cursor-pointer">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={useDefault}
                  onChange={(e) => handleUseDefaultChange(e.target.checked)}
                  className="sr-only"
                />
                <div className={`w-10 h-6 rounded-full transition-colors ${useDefault ? 'bg-cyan-500' : 'bg-white/20'}`}>
                  <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${useDefault ? 'translate-x-4' : ''}`} />
                </div>
              </div>
              <span className="text-sm text-white/70">使用默认地址</span>
            </label>
            
            {/* 自定义地址输入框 */}
            {!useDefault && (
              <div className="space-y-2">
                <label className="block text-xs text-white/50">自定义地址</label>
                <input
                  type="url"
                  value={apiUrl}
                  onChange={(e) => {
                    setApiUrl(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="https://api.example.com"
                  className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:border-cyan-400 transition-colors"
                />
              </div>
            )}
          </div>

          {/* API 连接测试 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-white/80">
                连接测试
              </label>
              <button
                onClick={handleTestConnection}
                disabled={isTesting}
                className="px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white/80 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
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
                    <div className="flex items-center gap-2 text-white/70">
                      <span>延迟:</span>
                      <span className="font-mono text-green-400">{testResult.latencyMs}ms</span>
                    </div>
                  )}
                  {testResult.success && testResult.serverStatus && (
                    <div className="flex items-center gap-2 text-white/70">
                      <span>状态:</span>
                      <span className="font-mono text-green-400">{testResult.serverStatus}</span>
                    </div>
                  )}
                  {!testResult.success && testResult.error && (
                    <p className="text-red-300">{testResult.error}</p>
                  )}
                </div>
              </div>
            )}

            {/* 未测试时的提示 */}
            {!testResult && !isTesting && (
              <p className="text-xs text-white/40">
                点击"测试连接"验证 API 服务是否可用
              </p>
            )}
          </div>
          
          {/* 错误提示 */}
          {error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">
              {error}
            </div>
          )}
        </div>
        
        {/* 操作按钮 */}
        <div className="flex gap-3 px-6 py-4 border-t border-white/10 sticky bottom-0 bg-slate-800">
          <button
            onClick={closeModal}
            className="flex-1 py-2.5 bg-white/10 text-white/80 font-medium rounded-lg hover:bg-white/20 transition-colors"
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

