import React, { useEffect, useState } from 'react';
import { invoke, isTauri } from '../../lib/tauri';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ApiResponse, User } from '../../types';
import SettingsModal from '../Settings/SettingsModal';
import { useDesktopBrandingStore } from '../../stores/desktopBrandingStore';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  clientType: string;
  expiresIn: number;
  user: User;
}

export default function LoginPage(props: { isDark: boolean; onToggleTheme: (e?: React.MouseEvent) => void }) {
  const { isDark, onToggleTheme } = props;
  const { login } = useAuthStore();
  const { openModal } = useSettingsStore();
  const loadConfig = useSettingsStore((s) => s.loadConfig);
  const branding = useDesktopBrandingStore((s) => s.branding);
  const refreshBranding = useDesktopBrandingStore((s) => s.refresh);
  // const getAssetUrl = useDesktopBrandingStore((s) => s.getAssetUrl); // 可用于获取其他资源 URL
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  const REMEMBER_KEY = 'prd-desktop-login-remember-username';
  const [form, setForm] = useState(() => {
    let savedUsername = '';
    try {
      savedUsername = sessionStorage.getItem(REMEMBER_KEY) || '';
    } catch {
      savedUsername = '';
    }
    return { username: savedUsername, password: '' };
  });
  const [rememberUsername, setRememberUsername] = useState(() => {
    try {
      return sessionStorage.getItem(REMEMBER_KEY) !== null;
    } catch {
      return false;
    }
  });

  // 启动时：同步 config + 在线模式拉一次品牌配置（登录 icon + 名称）
  useEffect(() => {
    if (!isTauri()) return;
    void loadConfig();
    // 传递当前主题，获取对应皮肤的资源
    const skin = isDark ? 'dark' : 'white';
    void refreshBranding('startup', skin);
  }, [loadConfig, refreshBranding, isDark]);

  // 直接使用后端返回的 URL（已包含回退逻辑）
  // 方式1：使用特定的 URL 字段（推荐用于品牌配置的资源）
  const [iconSrc, setIconSrc] = useState<string>('');
  useEffect(() => {
    setIconSrc(branding.loginIconUrl || '');
  }, [branding.loginIconUrl]);

  // 方式2：使用 getAssetUrl 通过 key 获取任意资源（推荐用于其他资源）
  // 例如：const loadUrl = getAssetUrl('load'); // 获取加载动画 URL
  // 例如：const startLoadUrl = getAssetUrl('start_load'); // 获取启动加载 URL

  const [bgSrc, setBgSrc] = useState<string>('');
  const [bgType, setBgType] = useState<'image' | 'video' | null>(null);

  useEffect(() => {
    const url = branding.loginBackgroundUrl || '';
    if (!url) {
      setBgSrc('');
      setBgType(null);
      return;
    }
    setBgSrc(url);
    
    // 根据 URL 扩展名判断类型
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes('.mp4') || lowerUrl.includes('.webm') || lowerUrl.includes('.mov')) {
      setBgType('video');
    } else {
      setBgType('image');
    }
  }, [branding.loginBackgroundUrl]);

  // 图片背景：用预加载探测，失败则清空
  useEffect(() => {
    if (!bgSrc || bgType !== 'image') return;

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      // ok
    };
    img.onerror = () => {
      if (cancelled) return;
      setBgSrc('');
      setBgType(null);
    };
    img.src = bgSrc;
    return () => {
      cancelled = true;
    };
  }, [bgSrc, bgType]);

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
        // 登录成功后再持久化"记住用户名"，避免输错也被记住
        try {
          if (rememberUsername) {
            sessionStorage.setItem(REMEMBER_KEY, response.data.user.username || form.username);
          } else {
            sessionStorage.removeItem(REMEMBER_KEY);
          }
        } catch {
          // ignore
        }
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

      {/* 服务端品牌背景图/视频（可选；失败自动回退到内置背景） */}
      {bgSrc && bgType === 'image' ? (
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
          {/* 轻遮罩，保证文本可读性（保持"黑白系"风格） */}
          <div className="absolute inset-0 bg-white/40 dark:bg-black/35" />
        </div>
      ) : bgSrc && bgType === 'video' ? (
        <div className="absolute inset-0 z-0 pointer-events-none" aria-hidden="true">
          <video
            src={bgSrc}
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
            style={{
              filter: 'saturate(0.95) contrast(0.95)',
            }}
            onError={() => {
              // 视频加载失败，清空
              setBgSrc('');
              setBgType(null);
            }}
          />
          {/* 轻遮罩，保证文本可读性（保持"黑白系"风格） */}
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

      {/* 右上角：夜晚模式 + 设置 */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <button
          onClick={(e) => onToggleTheme(e)}
          className="p-2.5 rounded-xl ui-glass-panel hover:bg-black/5 dark:hover:bg-white/10 transition-all hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100"
          title={isDark ? '切换到亮色模式' : '切换到暗色模式'}
          type="button"
        >
          {isDark ? (
            <svg className="w-5 h-5 text-slate-700/80 dark:text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-slate-700/80 dark:text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          )}
        </button>
        <button
          onClick={openModal}
          className="p-2.5 rounded-xl ui-glass-panel hover:bg-black/5 dark:hover:bg-white/10 transition-all hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100"
          title="设置"
          type="button"
        >
          <svg className="w-5 h-5 text-slate-700/80 dark:text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* 设置模态框 */}
      <SettingsModal />

      <div className="relative z-10 w-full max-w-md p-8 ui-login-card animate-slide-up motion-reduce:animate-none">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 overflow-hidden bg-transparent">
      {iconSrc ? (
              <img
                src={iconSrc}
                alt="login icon"
                className="w-full h-full object-contain"
                onError={() => {
                  // 回退到内置（但不强制把 branding 置回 local，避免影响 desktopName/bgKey）
                  setIconSrc('');
                }}
              />
            ) : (
              <div className="w-full h-full rounded-2xl bg-slate-900 dark:bg-white flex items-center justify-center">
                <span className="text-white dark:text-slate-900 font-bold text-2xl">P</span>
              </div>
            )}
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{branding.desktopName || 'PRD Agent'}</h1>
          <p className="text-slate-600 dark:text-white/60 text-sm mt-2">{branding.desktopSubtitle || '智能PRD解读助手'}</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/25 rounded-lg text-red-700 dark:text-red-200 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            name="username"
            placeholder="用户名"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            autoComplete="username"
            className="w-full px-4 py-3 ui-control transition-colors"
            required
          />

          {/* 密码字段：右侧眼睛切换显隐 + 上方 Caps Lock 实时提示 */}
          <div className="space-y-1">
            {capsLockOn && (
              <div className="text-[12px] text-amber-600 dark:text-amber-300/90 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
                </svg>
                <span>大写锁定已开启</span>
              </div>
            )}
            <div className="relative flex items-center">
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                placeholder="密码"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                onKeyDown={(e) => {
                  if (typeof e.getModifierState === 'function') {
                    setCapsLockOn(e.getModifierState('CapsLock'));
                  }
                }}
                onKeyUp={(e) => {
                  if (typeof e.getModifierState === 'function') {
                    setCapsLockOn(e.getModifierState('CapsLock'));
                  }
                }}
                onBlur={() => setCapsLockOn(false)}
                autoComplete="current-password"
                className="w-full px-4 py-3 pr-12 ui-control transition-colors"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-800 hover:bg-black/5 dark:text-white/55 dark:hover:text-white/85 dark:hover:bg-white/10 transition-colors"
              >
                {showPassword ? (
                  // EyeOff
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-7 0-11-7-11-7a18.45 18.45 0 014.39-5.56M9.88 9.88a3 3 0 104.24 4.24M21 12s-1.5 2.5-4.07 4.5M14.12 5.46A10.06 10.06 0 0012 5C5 5 1 12 1 12m21 0l-21 0" />
                  </svg>
                ) : (
                  // Eye
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" strokeWidth={2} />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* 记住用户名（密码不会被存储） */}
          <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-slate-700/85 hover:text-slate-900 dark:text-white/65 dark:hover:text-white/85 transition-colors">
            <input
              type="checkbox"
              checked={rememberUsername}
              onChange={(e) => setRememberUsername(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer"
            />
            <span>记住用户名</span>
          </label>

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

