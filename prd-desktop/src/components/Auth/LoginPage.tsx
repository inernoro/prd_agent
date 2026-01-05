import { useEffect, useMemo, useState } from 'react';
import { invoke, isTauri } from '../../lib/tauri';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ApiResponse, User } from '../../types';
import SettingsModal from '../Settings/SettingsModal';
import { useDesktopBrandingStore } from '../../stores/desktopBrandingStore';
import { useRemoteAssetsStore } from '../../stores/remoteAssetsStore';
import { buildDesktopAssetUrl } from '../../lib/desktopAssetUrl';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  clientType: string;
  expiresIn: number;
  user: User;
}

export default function LoginPage() {
  const { login } = useAuthStore();
  const { openModal } = useSettingsStore();
  const loadConfig = useSettingsStore((s) => s.loadConfig);
  const branding = useDesktopBrandingStore((s) => s.branding);
  const refreshBranding = useDesktopBrandingStore((s) => s.refresh);
  const resetBranding = useDesktopBrandingStore((s) => s.resetToLocal);
  const assetsBaseUrl = useRemoteAssetsStore((s) => s.baseUrl);
  const skin = useRemoteAssetsStore((s) => s.skin);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    username: '',
    password: '',
  });

  // 启动时：同步 config（让 assetsBaseUrl 生效）+ 在线模式拉一次品牌配置（登录 icon + 名称）
  useEffect(() => {
    if (!isTauri()) return;
    void loadConfig();
    void refreshBranding('startup');
  }, [loadConfig, refreshBranding]);

  const iconUrls = useMemo(() => {
    return buildDesktopAssetUrl({
      baseUrl: assetsBaseUrl,
      key: branding.loginIconKey,
      skin: skin ?? null,
    });
  }, [assetsBaseUrl, branding.loginIconKey, skin]);

  const bgUrls = useMemo(() => {
    return buildDesktopAssetUrl({
      baseUrl: assetsBaseUrl,
      key: branding.loginBackgroundKey,
      skin: skin ?? null,
    });
  }, [assetsBaseUrl, branding.loginBackgroundKey, skin]);

  const [iconSrc, setIconSrc] = useState<string>('');
  useEffect(() => {
    if (branding.source !== 'server') {
      setIconSrc('');
      return;
    }
    // 先尝试 skin，再回落 base
    setIconSrc(iconUrls.skinUrl || iconUrls.baseUrl);
  }, [branding.source, iconUrls.baseUrl, iconUrls.skinUrl]);

  const [bgSrc, setBgSrc] = useState<string>('');
  useEffect(() => {
    if (branding.source !== 'server') {
      setBgSrc('');
      return;
    }
    if (!branding.loginBackgroundKey) {
      setBgSrc('');
      return;
    }
    // 先尝试 skin，再回落 base
    setBgSrc(bgUrls.skinUrl || bgUrls.baseUrl);
  }, [branding.loginBackgroundKey, branding.source, bgUrls.baseUrl, bgUrls.skinUrl]);

  // background 是 CSS 背景图，没有 onError：用预加载探测，并做 skin -> base -> 关闭 的回退
  useEffect(() => {
    if (!bgSrc) return;
    if (branding.source !== 'server') return;
    if (!branding.loginBackgroundKey) return;

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      // ok
    };
    img.onerror = () => {
      if (cancelled) return;
      if (bgSrc === bgUrls.skinUrl && bgUrls.baseUrl) {
        setBgSrc(bgUrls.baseUrl);
      } else {
        setBgSrc('');
      }
    };
    img.src = bgSrc;
    return () => {
      cancelled = true;
    };
  }, [bgSrc, bgUrls.baseUrl, bgUrls.skinUrl, branding.loginBackgroundKey, branding.source]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (!isTauri()) {
        setError('当前页面运行在浏览器环境，无法登录。请使用桌面窗口启动。');
        return;
      }
      const response = await invoke<ApiResponse<LoginResponse>>('login', {
        username: form.username,
        password: form.password,
      });

      if (response.success && response.data) {
        login(response.data.user, {
          accessToken: response.data.accessToken,
          refreshToken: response.data.refreshToken,
          sessionKey: response.data.sessionKey,
        });
      } else {
        setError(response.error?.message || '登录失败');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-background dark:bg-background relative overflow-hidden animate-fade-in motion-reduce:animate-none">
      {/* 桌面端：提供“整屏背景可拖拽”的拖拽层（避免顶部小条被层级盖住导致不可拖拽） */}
      {isTauri() ? <div className="absolute inset-0 z-0" data-tauri-drag-region /> : null}

      {/* 服务端品牌背景图（可选；失败自动回退到内置背景） */}
      {branding.source === 'server' && bgSrc ? (
        <div className="absolute inset-0 z-0 pointer-events-none" aria-hidden="true">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url("${bgSrc}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              filter: 'saturate(0.95) contrast(0.95)',
            }}
          />
          {/* 轻遮罩，保证文本可读性（保持“黑白系”风格） */}
          <div className="absolute inset-0 bg-white/40 dark:bg-black/35" />
        </div>
      ) : null}

      {/* 黑白系轻背景（两层柔和径向光晕，避免“彩色渐变”） */}
      <div
        className="absolute inset-0 z-0 pointer-events-none"
        aria-hidden="true"
      >
        <div className="absolute -inset-[35%] bg-[radial-gradient(900px_circle_at_25%_20%,rgba(0,0,0,0.06),transparent_55%)] dark:bg-[radial-gradient(900px_circle_at_25%_20%,rgba(255,255,255,0.09),transparent_55%)]" />
        <div className="absolute -inset-[35%] bg-[radial-gradient(900px_circle_at_75%_80%,rgba(0,0,0,0.04),transparent_55%)] dark:bg-[radial-gradient(900px_circle_at_75%_80%,rgba(255,255,255,0.06),transparent_55%)]" />
      </div>

      {/* 右上角设置按钮 */}
      <button
        onClick={openModal}
        className="absolute top-4 right-4 z-20 p-2.5 rounded-xl ui-glass-panel hover:bg-black/5 dark:hover:bg-white/10 transition-all hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100"
        title="设置"
      >
        <svg className="w-5 h-5 text-slate-700/80 dark:text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {/* 设置模态框 */}
      <SettingsModal />

      <div className="relative z-10 w-full max-w-md p-8 ui-login-card animate-slide-up motion-reduce:animate-none">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 overflow-hidden bg-slate-900 dark:bg-white">
            {branding.source === 'server' && iconSrc ? (
              <img
                src={iconSrc}
                alt="login icon"
                className="w-16 h-16 object-cover"
                onError={() => {
                  if (iconSrc === iconUrls.skinUrl && iconUrls.baseUrl) {
                    setIconSrc(iconUrls.baseUrl);
                  } else {
                    // 回退到内置
                    resetBranding();
                  }
                }}
              />
            ) : (
              <span className="text-white dark:text-slate-900 font-bold text-2xl">P</span>
            )}
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{branding.desktopName || 'PRD Agent'}</h1>
          <p className="text-slate-600 dark:text-white/60 text-sm mt-2">智能PRD解读助手</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/25 rounded-lg text-red-700 dark:text-red-200 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder="用户名"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="w-full px-4 py-3 ui-control transition-colors"
            required
          />
          
          <input
            type="password"
            placeholder="密码"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full px-4 py-3 ui-control transition-colors"
            required
          />

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg font-medium transition-all disabled:opacity-50 motion-reduce:transition-none active:scale-[0.99] motion-reduce:active:scale-100 bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            {loading ? '请稍候...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}

