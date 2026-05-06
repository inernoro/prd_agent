import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Sparkles, Terminal, Lock, User as UserIcon, Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { getAdminAuthzMe, login, resetPassword } from '@/services';
import { StaticBackdrop } from '@/pages/home/components/StaticBackdrop';
import { Reveal } from '@/pages/home/components/Reveal';
import { HERO_GRADIENT } from '@/pages/home/sections/HeroSection';

/**
 * LoginPage — 沿用 /home 的 Linear × Retro-Futurism 视觉语言
 *
 * 设计原则见 doc/rule.landing-visual-style.md
 *
 * 结构：
 *   1 · StaticBackdrop 静态背景（六层 CSS）
 *   2 · Hero 本地 retro 装饰（synthwave 地平线 + 合成太阳 + Tron 地板）
 *   3 · 中心玻璃卡片（HUD chip eyebrow + Space Grotesk 标题 + 表单 + HERO_GRADIENT 主 CTA）
 *   4 · 所有元素走 Reveal 阶梯进场
 *
 * 业务逻辑（login / 首次登录重置密码 / 权限拉取）保持与旧版一致，只改视觉层。
 */

const passwordRules: Array<{ key: string; label: string; test: (pwd: string) => boolean }> = [
  { key: 'len', label: '长度 8-128 位', test: (pwd) => pwd.length >= 8 && pwd.length <= 128 },
  { key: 'letter', label: '包含字母', test: (pwd) => /[a-zA-Z]/.test(pwd) },
  { key: 'digit', label: '包含数字', test: (pwd) => /\d/.test(pwd) },
];

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.login);
  const setTokens = useAuthStore((s) => s.setTokens);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const setPermissionsLoaded = useAuthStore((s) => s.setPermissionsLoaded);
  const setCdnBaseUrl = useAuthStore((s) => s.setCdnBaseUrl);
  const logout = useAuthStore((s) => s.logout);
  const isAuthed = useAuthStore((s) => s.isAuthenticated);
  const [searchParams] = useSearchParams();
  const returnUrl = searchParams.get('returnUrl') || '/';
  const [loading, setLoading] = useState(false);

  const [username, setUsername] = useState(() => {
    try {
      return sessionStorage.getItem('prd-login-remember-username') || 'admin';
    } catch {
      return 'admin';
    }
  });
  const [password, setPassword] = useState('');
  const [rememberUsername, setRememberUsername] = useState(() => {
    try {
      return sessionStorage.getItem('prd-login-remember-username') !== null;
    } catch {
      return false;
    }
  });
  const [error, setError] = useState<string | null>(null);

  // 首次登录重置密码相关状态
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetUserId, setResetUserId] = useState('');
  const [resetAccessToken, setResetAccessToken] = useState('');
  const [resetRefreshToken, setResetRefreshToken] = useState('');
  const [resetSessionKey, setResetSessionKey] = useState('');
  const [resetUserData, setResetUserData] = useState<Parameters<typeof setAuth>[0] | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const canSubmit = useMemo(() => Boolean(username.trim() && password.trim()), [username, password]);
  const canResetSubmit = useMemo(() => Boolean(newPassword.trim() && confirmPassword.trim()), [newPassword, confirmPassword]);

  useEffect(() => {
    if (isAuthed) navigate(returnUrl, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed, navigate]);

  const onSubmit = async () => {
    if (!canSubmit || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await login(username.trim(), password);
      if (!res.success) {
        setError(res.error?.message || '登录失败');
        return;
      }

      // 检查是否需要重置密码
      if (res.data.mustResetPassword) {
        setResetUserId(res.data.user.userId);
        setResetAccessToken(res.data.accessToken);
        setResetRefreshToken(res.data.refreshToken);
        setResetSessionKey(res.data.sessionKey);
        setResetUserData(res.data.user);
        setShowResetPassword(true);
        return;
      }

      // 不需要重置密码，正常登录流程
      await completeLogin(res.data.user, res.data.accessToken, res.data.refreshToken, res.data.sessionKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const completeLogin = async (
    user: Parameters<typeof setAuth>[0],
    accessToken: string,
    refreshToken: string,
    sessionKey: string
  ) => {
    setAuth(user, accessToken);
    setTokens(accessToken, refreshToken, sessionKey);
    setPermissionsLoaded(false);

    // 拉取后台权限（决定菜单/路由可见性与准入）
    const authz = await getAdminAuthzMe();
    if (!authz.success) {
      // 若无 admin.access 权限，后端会 403，这里直接回到登录态
      logout();
      setError(authz.error?.message || '无权限进入管理后台');
      return;
    }
    setPermissions(authz.data.effectivePermissions || []);
    if (authz.data.cdnBaseUrl) setCdnBaseUrl(authz.data.cdnBaseUrl);
    setPermissionsLoaded(true);
    // 保留登录完成标志，供主应用背景动效衔接使用
    try {
      sessionStorage.setItem('prd-postlogin-fx', '1');
    } catch {
      // ignore
    }
    try {
      if (rememberUsername) {
        sessionStorage.setItem('prd-login-remember-username', user.username || '');
      } else {
        sessionStorage.removeItem('prd-login-remember-username');
      }
    } catch {
      // ignore
    }
    navigate(returnUrl, { replace: true });
  };

  const onResetPassword = async () => {
    if (!canResetSubmit || resetLoading) return;
    setResetLoading(true);
    setResetError(null);

    // 前端校验密码强度
    const failedRule = passwordRules.find((r) => !r.test(newPassword));
    if (failedRule) {
      setResetError(`密码不符合要求：${failedRule.label}`);
      setResetLoading(false);
      return;
    }

    // 前端校验两次密码是否一致
    if (newPassword !== confirmPassword) {
      setResetError('两次输入的密码不一致');
      setResetLoading(false);
      return;
    }

    try {
      const res = await resetPassword(resetUserId, newPassword, confirmPassword);
      if (!res.success) {
        setResetError(res.error?.message || '重置密码失败');
        return;
      }

      // 重置密码成功，继续登录流程
      if (resetUserData) {
        await completeLogin(resetUserData, resetAccessToken, resetRefreshToken, resetSessionKey);
      }
    } catch (e) {
      setResetError(e instanceof Error ? e.message : '重置密码失败');
    } finally {
      setResetLoading(false);
    }
  };

  const onBackToLogin = () => {
    setShowResetPassword(false);
    setResetUserId('');
    setResetAccessToken('');
    setResetRefreshToken('');
    setResetSessionKey('');
    setResetUserData(null);
    setNewPassword('');
    setConfirmPassword('');
    setResetError(null);
  };

  return (
    <div
      className="relative min-h-screen w-full overflow-hidden bg-[#030306] text-white"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* Layer 1 · 全站静态背景 */}
      <StaticBackdrop />

      {/* Layer 2 · Hero 局部 retro 装饰（synthwave 地平线 + 合成太阳 + Tron 地板）*/}
      <RetroHorizon />

      {/* Layer 3 · 居中玻璃卡片 */}
      <div className="relative z-10 min-h-screen flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[460px]">
          {!showResetPassword ? (
            <LoginCard
              username={username}
              password={password}
              error={error}
              loading={loading}
              canSubmit={canSubmit}
              rememberUsername={rememberUsername}
              onUsernameChange={setUsername}
              onPasswordChange={setPassword}
              onRememberChange={setRememberUsername}
              onSubmit={onSubmit}
            />
          ) : (
            <ResetCard
              newPassword={newPassword}
              confirmPassword={confirmPassword}
              error={resetError}
              loading={resetLoading}
              canSubmit={canResetSubmit}
              onNewPasswordChange={setNewPassword}
              onConfirmPasswordChange={setConfirmPassword}
              onSubmit={onResetPassword}
              onBack={onBackToLogin}
            />
          )}
        </div>
      </div>

      {/* keyframes: 标题慢呼吸 + HUD 脉冲（与 HeroSection 完全同规格）*/}
      <style>{`
        @keyframes login-title-pulse {
          0%, 100% {
            text-shadow:
              0 0 30px rgba(203, 213, 225, 0.32),
              0 0 90px rgba(0, 240, 255, 0.22),
              0 0 140px rgba(59, 130, 246, 0.12);
          }
          50% {
            text-shadow:
              0 0 40px rgba(226, 232, 240, 0.45),
              0 0 110px rgba(0, 240, 255, 0.30),
              0 0 160px rgba(59, 130, 246, 0.18);
          }
        }
        @keyframes login-hud-pulse {
          0%, 100% {
            box-shadow:
              0 0 28px rgba(148, 163, 184, 0.18),
              inset 0 0 14px rgba(148, 163, 184, 0.05);
          }
          50% {
            box-shadow:
              0 0 38px rgba(203, 213, 225, 0.28),
              inset 0 0 20px rgba(203, 213, 225, 0.08);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-login-pulse] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  装饰：Synthwave 地平线 + 合成太阳 + Tron 地板
 *  （与 HeroSection.tsx 前 100 行完全同构，搬到本页做本地装饰）
 * ────────────────────────────────────────────────────────────────────────── */
function RetroHorizon() {
  return (
    <>
      {/* Synthwave 地平线光带 */}
      <div
        className="absolute inset-x-0 pointer-events-none z-0"
        style={{
          top: '72vh',
          height: '2px',
          background:
            'linear-gradient(90deg, transparent 0%, rgba(244, 63, 94, 0.5) 30%, rgba(226, 232, 240, 0.9) 50%, rgba(0, 240, 255, 0.5) 70%, transparent 100%)',
          boxShadow:
            '0 0 28px rgba(226, 232, 240, 0.5), 0 -1px 40px rgba(244, 63, 94, 0.3)',
        }}
      />

      {/* 合成太阳半圆 */}
      <div
        className="absolute pointer-events-none z-0"
        style={{
          top: '72vh',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'clamp(360px, 34vw, 560px)',
          height: 'clamp(360px, 34vw, 560px)',
          background:
            'radial-gradient(circle at center, rgba(244, 63, 94, 0.32) 0%, rgba(203, 213, 225, 0.15) 35%, rgba(0, 240, 255, 0.05) 60%, transparent 75%)',
          filter: 'blur(6px)',
        }}
      />

      {/* Tron 透视地板 */}
      <div
        className="absolute inset-x-0 pointer-events-none z-0"
        style={{
          top: '72vh',
          bottom: '0',
          perspective: '420px',
          perspectiveOrigin: '50% 0%',
        }}
      >
        <div
          className="absolute inset-x-[-35%] top-0 bottom-0"
          style={{
            background: `
              repeating-linear-gradient(
                180deg,
                transparent 0,
                transparent 43px,
                rgba(203, 213, 225, 0.38) 43px,
                rgba(203, 213, 225, 0.38) 44px
              ),
              repeating-linear-gradient(
                90deg,
                transparent 0,
                transparent 43px,
                rgba(0, 240, 255, 0.38) 43px,
                rgba(0, 240, 255, 0.38) 44px
              )
            `,
            transform: 'rotateX(62deg)',
            transformOrigin: '50% 0%',
            maskImage:
              'linear-gradient(180deg, transparent 0%, black 38%, black 100%)',
            WebkitMaskImage:
              'linear-gradient(180deg, transparent 0%, black 38%, black 100%)',
          }}
        />
      </div>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  HUD chip（eyebrow 状态条）—— 与 HeroSection 状态条同规格
 * ────────────────────────────────────────────────────────────────────────── */
function HudChip({ label, sublabel }: { label: string; sublabel?: string }) {
  return (
    <div
      data-login-pulse
      className="inline-flex items-center gap-3 px-4 py-2 rounded-md"
      style={{
        background: 'rgba(10, 14, 22, 0.72)',
        border: '1px solid rgba(203, 213, 225, 0.22)',
        boxShadow:
          '0 0 28px rgba(148, 163, 184, 0.18), inset 0 0 14px rgba(148, 163, 184, 0.05)',
        fontFamily: 'var(--font-terminal)',
        animation: 'login-hud-pulse 4s ease-in-out infinite',
      }}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70" />
        <span
          className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"
          style={{ boxShadow: '0 0 10px #34d399' }}
        />
      </span>
      <span
        className="text-[14px] text-emerald-300"
        style={{
          letterSpacing: '0.14em',
          textShadow: '0 0 8px rgba(52, 211, 153, 0.6)',
        }}
      >
        {label}
      </span>
      {sublabel && (
        <>
          <span className="w-px h-3.5 bg-white/15" />
          <span
            className="text-[14px] text-slate-200"
            style={{
              letterSpacing: '0.14em',
              textShadow: '0 0 10px rgba(203, 213, 225, 0.5)',
            }}
          >
            {sublabel}
          </span>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  MAP logo —— 与 LandingPage 同规格
 * ────────────────────────────────────────────────────────────────────────── */
function MapMark({ className = 'w-14 h-14' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="mapLoginGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#00f0ff', stopOpacity: 1 }} />
          <stop offset="50%" style={{ stopColor: '#7c3aed', stopOpacity: 1 }} />
          <stop offset="100%" style={{ stopColor: '#f43f5e', stopOpacity: 1 }} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="512" height="512" rx="102" ry="102" fill="url(#mapLoginGradient)" />
      <text
        x="256"
        y="268"
        fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
        fontSize="190"
        fontWeight="900"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#ffffff"
        letterSpacing="-6"
      >
        MAP
      </text>
    </svg>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  输入框 —— 玻璃化 + accent focus ring
 * ────────────────────────────────────────────────────────────────────────── */
interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  Icon?: typeof UserIcon;
}

function Field({ label, value, onChange, onEnter, type = 'text', placeholder, autoComplete, Icon }: FieldProps) {
  return (
    <label className="block">
      <span
        className="block mb-2 text-[11px] uppercase text-white/55"
        style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.2em' }}
      >
        {label}
      </span>
      <div
        className="relative flex items-center rounded-xl transition-colors focus-within:border-white/35"
        style={{
          background: 'rgba(10, 14, 22, 0.62)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
        }}
      >
        {Icon && (
          <span className="pl-4 pr-1 text-white/45">
            <Icon className="w-4 h-4" />
          </span>
        )}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter?.();
          }}
          type={type}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="h-12 w-full bg-transparent px-4 text-[14.5px] text-white placeholder-white/30 outline-none"
          style={{ fontFamily: 'var(--font-body)' }}
        />
      </div>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  主 CTA —— HERO_GRADIENT pill
 * ────────────────────────────────────────────────────────────────────────── */
function PrimaryPill({
  children,
  onClick,
  disabled,
  loading,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group relative inline-flex w-full items-center justify-center gap-2.5 h-12 px-8 rounded-full font-medium text-[14.5px] text-white transition-all duration-200 hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
      style={{
        background: HERO_GRADIENT,
        boxShadow:
          '0 0 48px rgba(124, 58, 237, 0.35), 0 0 100px rgba(0, 240, 255, 0.2), 0 10px 32px rgba(0, 0, 0, 0.5)',
        letterSpacing: '0.01em',
        fontFamily: 'var(--font-display)',
      }}
    >
      {loading ? (
        <span
          className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin"
          aria-hidden
        />
      ) : (
        <Sparkles className="w-4 h-4" />
      )}
      <span>{children}</span>
      {!loading && (
        <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
      )}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  错误条
 * ────────────────────────────────────────────────────────────────────────── */
function ErrorBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl px-4 py-3 text-[13px]"
      style={{
        background: 'rgba(244, 63, 94, 0.08)',
        border: '1px solid rgba(244, 63, 94, 0.35)',
        color: 'rgba(252, 165, 165, 0.95)',
        boxShadow: '0 0 24px rgba(244, 63, 94, 0.12)',
        fontFamily: 'var(--font-body)',
      }}
    >
      {children}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  玻璃卡片外壳（遵循 R9）
 * ────────────────────────────────────────────────────────────────────────── */
function GlassCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[22px] p-8"
      style={{
        background: 'rgba(10, 14, 22, 0.72)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        boxShadow:
          '0 18px 54px rgba(0, 0, 0, 0.55), inset 0 0 10px rgba(148, 163, 184, 0.04)',
      }}
    >
      {children}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  登录卡
 * ────────────────────────────────────────────────────────────────────────── */
interface LoginCardProps {
  username: string;
  password: string;
  error: string | null;
  loading: boolean;
  canSubmit: boolean;
  rememberUsername: boolean;
  onUsernameChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onRememberChange: (v: boolean) => void;
  onSubmit: () => void;
}

function LoginCard({
  username,
  password,
  error,
  loading,
  canSubmit,
  rememberUsername,
  onUsernameChange,
  onPasswordChange,
  onRememberChange,
  onSubmit,
}: LoginCardProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  return (
    <GlassCard>
      {/* Brand row */}
      <Reveal delay={0}>
        <div className="flex items-center gap-4 mb-6">
          <MapMark className="w-14 h-14 rounded-[16px]" />
          <div className="min-w-0">
            <div
              className="text-[20px] font-medium text-white"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
            >
              MAP Admin
            </div>
            <div
              className="text-[12.5px] text-white/55"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              米多 Agent 管理后台
            </div>
          </div>
        </div>
      </Reveal>

      {/* HUD eyebrow */}
      <Reveal delay={60}>
        <div className="mb-5">
          <HudChip label="LIVE · READY" sublabel="SECURE PORTAL" />
        </div>
      </Reveal>

      {/* Heading */}
      <Reveal delay={120}>
        <h1
          data-login-pulse
          className="text-white font-medium"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(1.75rem, 2.8vw, 2.25rem)',
            lineHeight: 1.08,
            letterSpacing: '-0.03em',
            animation: 'login-title-pulse 5s ease-in-out infinite',
          }}
        >
          欢迎回来
        </h1>
      </Reveal>

      <Reveal delay={180}>
        <p
          className="mt-3 text-[14px] text-white/62 leading-relaxed"
          style={{ fontFamily: 'var(--font-body)' }}
        >
          使用管理员账号登录以进入控制台。
        </p>
      </Reveal>

      {/* Form */}
      <div className="mt-7 grid gap-4">
        <Reveal delay={240}>
          <Field
            label="USERNAME"
            value={username}
            onChange={onUsernameChange}
            placeholder="admin"
            autoComplete="username"
            Icon={UserIcon}
          />
        </Reveal>

        <Reveal delay={300}>
          <label className="block">
            <span
              className="mb-2 flex items-center justify-between text-[11px] uppercase text-white/55"
              style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.2em' }}
            >
              <span>PASSWORD</span>
              {capsLockOn && (
                <span
                  className="normal-case tracking-normal text-[11px] text-amber-300/90"
                  style={{ letterSpacing: 0 }}
                >
                  大写锁定已开启
                </span>
              )}
            </span>
            <div
              className="relative flex items-center rounded-xl transition-colors focus-within:border-white/35"
              style={{
                background: 'rgba(10, 14, 22, 0.62)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            >
              <span className="pl-4 pr-1 text-white/45">
                <Lock className="w-4 h-4" />
              </span>
              <input
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                onKeyDown={(e) => {
                  if (typeof e.getModifierState === 'function') {
                    setCapsLockOn(e.getModifierState('CapsLock'));
                  }
                  if (e.key === 'Enter') onSubmit();
                }}
                onKeyUp={(e) => {
                  if (typeof e.getModifierState === 'function') {
                    setCapsLockOn(e.getModifierState('CapsLock'));
                  }
                }}
                onBlur={() => setCapsLockOn(false)}
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="current-password"
                className="h-12 w-full bg-transparent px-4 text-[14.5px] text-white placeholder-white/30 outline-none"
                style={{ fontFamily: 'var(--font-body)' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
                className="mr-2 flex h-9 w-9 items-center justify-center rounded-lg text-white/55 hover:text-white/85 hover:bg-white/5 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>
        </Reveal>

        <Reveal delay={340}>
          <label className="flex items-center gap-2 cursor-pointer select-none text-[12.5px] text-white/65 hover:text-white/85 transition-colors">
            <input
              type="checkbox"
              checked={rememberUsername}
              onChange={(e) => onRememberChange(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-white/85"
            />
            <span style={{ fontFamily: 'var(--font-body)' }}>记住用户名</span>
          </label>
        </Reveal>

        {error && (
          <Reveal delay={0}>
            <ErrorBar>{error}</ErrorBar>
          </Reveal>
        )}

        <Reveal delay={360}>
          <div className="mt-2">
            <PrimaryPill onClick={onSubmit} disabled={!canSubmit || loading} loading={loading}>
              {loading ? '登录中…' : '进入控制台'}
            </PrimaryPill>
          </div>
        </Reveal>

        <Reveal delay={440}>
          <div
            className="mt-1 inline-flex items-center gap-2 text-[11.5px] text-white/45"
            style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.1em' }}
          >
            <Terminal className="w-3 h-3" />
            <span>DEFAULT · admin / admin · 首次登录后请修改密码</span>
          </div>
        </Reveal>
      </div>
    </GlassCard>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  重置密码卡
 * ────────────────────────────────────────────────────────────────────────── */
interface ResetCardProps {
  newPassword: string;
  confirmPassword: string;
  error: string | null;
  loading: boolean;
  canSubmit: boolean;
  onNewPasswordChange: (v: string) => void;
  onConfirmPasswordChange: (v: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}

function ResetCard({
  newPassword,
  confirmPassword,
  error,
  loading,
  canSubmit,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
  onBack,
}: ResetCardProps) {
  return (
    <GlassCard>
      <Reveal delay={0}>
        <div className="flex items-center gap-4 mb-6">
          <MapMark className="w-14 h-14 rounded-[16px]" />
          <div className="min-w-0">
            <div
              className="text-[20px] font-medium text-white"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
            >
              设置新密码
            </div>
            <div
              className="text-[12.5px] text-white/55"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              首次登录需要重置密码
            </div>
          </div>
        </div>
      </Reveal>

      <Reveal delay={60}>
        <div className="mb-5">
          <HudChip label="RESET · REQUIRED" sublabel="FIRST LOGIN" />
        </div>
      </Reveal>

      <div className="mt-2 grid gap-4">
        <Reveal delay={120}>
          <Field
            label="NEW PASSWORD"
            value={newPassword}
            onChange={onNewPasswordChange}
            type="password"
            placeholder="请输入新密码"
            autoComplete="new-password"
            Icon={Lock}
          />
        </Reveal>

        <Reveal delay={180}>
          <Field
            label="CONFIRM PASSWORD"
            value={confirmPassword}
            onChange={onConfirmPasswordChange}
            onEnter={onSubmit}
            type="password"
            placeholder="请再次输入新密码"
            autoComplete="new-password"
            Icon={Lock}
          />
        </Reveal>

        {/* 密码强度 checklist */}
        <Reveal delay={240}>
          <div
            className="rounded-xl px-4 py-3 grid gap-1.5"
            style={{
              background: 'rgba(10, 14, 22, 0.52)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            {passwordRules.map((rule) => {
              const pass = newPassword ? rule.test(newPassword) : false;
              return (
                <div
                  key={rule.key}
                  className="flex items-center gap-2 text-[12px]"
                  style={{
                    fontFamily: 'var(--font-terminal)',
                    letterSpacing: '0.08em',
                    color: pass
                      ? 'rgba(52, 211, 153, 0.95)'
                      : newPassword
                        ? 'rgba(252, 165, 165, 0.85)'
                        : 'rgba(255, 255, 255, 0.45)',
                  }}
                >
                  <span className="inline-flex w-4 justify-center">{pass ? '✓' : '·'}</span>
                  <span>{rule.label.toUpperCase()}</span>
                </div>
              );
            })}
          </div>
        </Reveal>

        {error && (
          <Reveal delay={0}>
            <ErrorBar>{error}</ErrorBar>
          </Reveal>
        )}

        <Reveal delay={300}>
          <div className="mt-1">
            <PrimaryPill onClick={onSubmit} disabled={!canSubmit || loading} loading={loading}>
              {loading ? '设置中…' : '确认设置'}
            </PrimaryPill>
          </div>
        </Reveal>

        <Reveal delay={380}>
          <button
            type="button"
            onClick={onBack}
            className="self-start text-[12px] text-white/55 hover:text-white transition-colors"
            style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.14em' }}
          >
            ← BACK TO LOGIN
          </button>
        </Reveal>
      </div>
    </GlassCard>
  );
}
