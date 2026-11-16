import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Terminal, Lock, User as UserIcon, Eye, EyeOff } from 'lucide-react';
import { takeReturnFragment } from '@/app/returnFragment';
import { useAuthStore } from '@/stores/authStore';
import { getAdminAuthzMe, getSsoOptions, login, loginWithMiduoPlanetToken, resetPassword } from '@/services';
import type { SsoLoginOption } from '@/services/contracts/auth';
import { ConsciousnessHud, ConsciousnessScene, IdentityScanner, markConsciousnessArrival, type IdentityPhase } from '@/components/effects/ConsciousnessScene';
import { enterWorkspace, prepareEntryScene, profileEntryMotion } from '@/components/effects/entryMotion';
import { prefersReducedMotion } from '@/lib/themeApplier';
import { useApplyDocumentTheme } from '@/hooks/useApplyDocumentTheme';
import { Reveal } from '@/pages/home/components/Reveal';

/** Cinematic entry follows the reference film: fog, identity scan, contour, character.
 * Authentication, SSO return fragments and first-login password reset retain their existing flow.
 */

const passwordRules: Array<{ key: string; label: string; test: (pwd: string) => boolean }> = [
  { key: 'len', label: '长度 8-128 位', test: (pwd) => pwd.length >= 8 && pwd.length <= 128 },
  { key: 'letter', label: '包含字母', test: (pwd) => /[a-zA-Z]/.test(pwd) },
  { key: 'digit', label: '包含数字', test: (pwd) => /\d/.test(pwd) },
];

const MIDUO_SSO_STATE_KEY = 'prd-miduo-sso-state';

function normalizeAbsoluteHttpUrl(value: string | null | undefined, trimTrailingSlash = false) {
  const raw = (value || '').trim();
  if (!raw || raw.startsWith('/')) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    const normalized = url.toString();
    return trimTrailingSlash ? normalized.replace(/\/$/, '') : normalized;
  } catch {
    return null;
  }
}

function createSsoState() {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function LoginPage() {
  const navigate = useNavigate();
  useApplyDocumentTheme('/login');
  const setAuth = useAuthStore((s) => s.login);
  const setTokens = useAuthStore((s) => s.setTokens);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const setPermissionsLoaded = useAuthStore((s) => s.setPermissionsLoaded);
  const setCdnBaseUrl = useAuthStore((s) => s.setCdnBaseUrl);
  const logout = useAuthStore((s) => s.logout);
  const isAuthed = useAuthStore((s) => s.isAuthenticated);
  const [searchParams] = useSearchParams();
  /**
   * returnUrl 有两种形态，用错地方会把授权码泄出去：
   *
   * - **带 fragRef 的那份**（`raw`）：URL 上安全，可以到处传——包括拼进 SSO 的外部
   *   回跳地址。fragRef 只是一个不含语义的键。
   * - **还原出 fragment 的那份**：只能用在最后一步本地跳转。它里面可能是
   *   `#code=...`，一旦进了任何 query 就等于把「授权码只走 fragment」这件事作废。
   *
   * 上一版我在 render 期就把它还原成第二种，然后同一个值既喂给本地跳转、又喂给
   * `buildSsoHref` —— 于是授权码照样进了外部 SSO 的 query，我以为修好的那条路
   * 其实只堵住了入口、没堵住出口。所以现在默认形态是第一种，还原只发生在跳转那一刻。
   *
   * 还原也不能放在 render 里：`takeReturnFragment` 是「取走并删除」，而 StrictMode
   * 会故意重复执行 render 与 useMemo，第一次就把它消费掉，留下的那次拿到空值。
   */
  const returnUrlWithRef = searchParams.get('returnUrl') || '/';

  // 解析结果要缓存：takeReturnFragment 是「取走并删除」，而登录成功后有两条路都会
  // 走到跳转——setAuth 翻了 isAuthed 触发的那个 effect，和密码登录自己的那次
  // navigate。第一次把 fragment 消费掉，第二次拿到空的；两次跳转谁后到谁说了算，
  // 后到的那个把 code 和 state 抹掉，整条授权链要重走。
  // 一次性资源要么只有一个消费点，要么消费结果本身可复用——这里取后者。
  const resolvedReturnUrlRef = useRef<string | null>(null);

  const resolveReturnUrl = useCallback(() => {
    if (resolvedReturnUrlRef.current !== null) return resolvedReturnUrlRef.current;
    const raw = returnUrlWithRef;
    const at = raw.indexOf('?');
    const resolved = (() => {
      if (at < 0) return raw;
      const params = new URLSearchParams(raw.slice(at + 1));
      const ref = params.get('fragRef');
      if (!ref) return raw;
      params.delete('fragRef');
      const rest = params.toString();
      const fragment = takeReturnFragment(ref);
      return raw.slice(0, at) + (rest ? `?${rest}` : '') + fragment;
    })();
    resolvedReturnUrlRef.current = resolved;
    return resolved;
  }, [returnUrlWithRef]);
  const [loading, setLoading] = useState(false);
  useEffect(() => { void prepareEntryScene(); }, []);
  const [gatePhase, setGatePhase] = useState<IdentityPhase>('idle');
  const completingLogin = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

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
  const [ssoOptions, setSsoOptions] = useState<SsoLoginOption[]>([]);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [passwordLoginDisabled, setPasswordLoginDisabled] = useState(false);

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
    if (isAuthed && !completingLogin.current) navigate(resolveReturnUrl(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed, navigate]);

  useEffect(() => {
    let alive = true;
    getSsoOptions()
      .then((res) => {
        if (!alive) return;
        setSsoOptions(res.success ? res.data.items : []);
        setPasswordLoginDisabled(res.success ? res.data.passwordLoginDisabled : false);
      })
      .catch(() => {
        if (alive) {
          setSsoOptions([]);
          setPasswordLoginDisabled(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const provider = searchParams.get('ssoProvider');
    const token = searchParams.get('token') || searchParams.get('ssoToken') || searchParams.get('miduoToken');
    const appCode = searchParams.get('app_code') || searchParams.get('appCode');
    const source = searchParams.get('source');
    const isMiduoCallback = provider === 'miduo-planet' || Boolean(token && (appCode || source === 'bridge'));
    if (!isMiduoCallback || !token || ssoLoading) return;

    let alive = true;
    const stripSsoCallbackParams = () => {
      const next = new URLSearchParams(searchParams);
      ['token', 'ssoToken', 'miduoToken', 'ssoProvider', 'app_code', 'appCode', 'source', 'state'].forEach((key) => {
        next.delete(key);
      });
      const query = next.toString();
      navigate(query ? `/login?${query}` : '/login', { replace: true });
    };

    setSsoLoading(true);
    setError(null);

    const state = searchParams.get('state');
    const expectedState = sessionStorage.getItem(MIDUO_SSO_STATE_KEY);
    sessionStorage.removeItem(MIDUO_SSO_STATE_KEY);
    if (!state || !expectedState || expectedState !== state) {
      setError('米多星球登录状态校验失败，请重新发起登录');
      setSsoLoading(false);
      stripSsoCallbackParams();
      return;
    }

    loginWithMiduoPlanetToken(token)
      .then(async (res) => {
        if (!alive) return;
        if (!res.success) {
          setError(res.error?.message || '米多星球登录失败');
          stripSsoCallbackParams();
          return;
        }
        await completeLogin(res.data.user, res.data.accessToken, res.data.refreshToken, res.data.sessionKey);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : '米多星球登录失败');
        stripSsoCallbackParams();
      })
      .finally(() => {
        if (alive) setSsoLoading(false);
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const onSubmit = async () => {
    if (!canSubmit || loading) return;
    if (passwordLoginDisabled) {
      setError('当前环境已禁用密码登录，请使用 SSO 登录');
      return;
    }
    profileEntryMotion();
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
    completingLogin.current = true;
    setAuth(user, accessToken);
    setTokens(accessToken, refreshToken, sessionKey);
    setPermissionsLoaded(false);

    // 拉取后台权限（决定菜单/路由可见性与准入）
    const authz = await getAdminAuthzMe().catch((cause: unknown) => {
      completingLogin.current = false;
      logout();
      throw cause;
    });
    if (!authz.success) {
      // 若无 admin.access 权限，后端会 403，这里直接回到登录态
      logout();
      completingLogin.current = false;
      setGatePhase('idle');
      setError(authz.error?.message || '无权限进入管理后台');
      return;
    }
    setPermissions(authz.data.effectivePermissions || []);
    setCdnBaseUrl(authz.data.cdnBaseUrl || '', authz.data.legacyCdnBaseUrl);
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
    // Preparation must not keep a verified user waiting on a failed resource.
    if (!prefersReducedMotion()) await Promise.race([prepareEntryScene(), new Promise(resolve => window.setTimeout(resolve, 1000))]);
    if (!mounted.current) return;
    setGatePhase('authorized');
    if (!prefersReducedMotion()) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 760));
      if (!mounted.current) return;
      setGatePhase('entering');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 820));
    }
    if (!mounted.current) return;
    const destination = resolveReturnUrl();
    if (['/', '/agent-launcher'].includes(destination.split(/[?#]/)[0])) markConsciousnessArrival();
    enterWorkspace(() => navigate(destination, { replace: true }));
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
      const res = await resetPassword(resetUserId, newPassword, confirmPassword, resetAccessToken);
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

  const busy = loading || ssoLoading || resetLoading;
  const phase: IdentityPhase = gatePhase === 'idle' && busy ? 'verifying' : gatePhase;
  const authorized = phase === 'authorized' || phase === 'entering';
  return (
    <div className="cinema-login" data-busy={busy} data-phase={phase}>
      <ConsciousnessScene fog />
      <ConsciousnessHud login />
      <IdentityScanner phase={phase} />
      <main className="cinema-login-center" aria-label={showResetPassword ? '设置新密码' : '登录 MAP'}>
        {authorized ? <div className="cinema-identity-result" role="status"><div className="cinema-verified-copy"><p>读取完毕 · 核验通过</p><small>READ COMPLETE / VERIFIED</small></div><div className="cinema-welcome-copy"><p>WELCOME TO</p><small>YOUR INTELLIGENCE WORKSPACE</small><strong>MAP</strong></div></div> : <>
          {!showResetPassword ? (
            <LoginCard
              username={username}
              password={password}
              error={error}
              loading={loading}
              canSubmit={canSubmit}
              rememberUsername={rememberUsername}
              ssoOptions={ssoOptions}
              ssoLoading={ssoLoading}
              passwordLoginDisabled={passwordLoginDisabled}
              // 给 SSO 的必须是带 fragRef 的那份：它会被拼进外部地址。
              returnUrl={returnUrlWithRef}
              onError={setError}
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
        </>}
      </main>
      <div className="cinema-login-status" role={phase === 'verifying' ? 'status' : undefined}>
        {authorized ? '身份已确认，正在进入工作空间' : busy ? '正在读取身份与访问权限' : '身份资料确认 · 等待你的指令'}
        <small>{authorized ? 'IDENTITY VERIFIED / ENTERING WORKSPACE' : busy ? 'READING IDENTITY / PLEASE WAIT' : 'IDENTITY AWAITING / READY TO CONNECT'}</small>
      </div>
    </div>
  );
}

function MapMark({ className = 'w-14 h-14' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="mapLoginGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: 'var(--login-mark-start)', stopOpacity: 1 }} />
          <stop offset="50%" style={{ stopColor: 'var(--login-mark-mid)', stopOpacity: 1 }} />
          <stop offset="100%" style={{ stopColor: 'var(--login-mark-end)', stopOpacity: 1 }} />
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
        className="block mb-2 text-[11px] uppercase text-token-secondary"
        style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.2em' }}
      >
        {label}
      </span>
      <div
        className="relative flex items-center rounded-xl transition-colors focus-within:border-token-subtle"
        style={{
          background: 'var(--login-field-bg)',
          border: '1px solid var(--login-border)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
        }}
      >
        {Icon && (
          <span className="pl-4 pr-1 text-token-secondary">
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
          className="h-12 w-full bg-transparent px-4 text-[14.5px] text-token-primary placeholder:text-token-muted outline-none"
          style={{ fontFamily: 'var(--font-body)' }}
        />
      </div>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  主 CTA —— 登录页石墨银渐变 pill
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
      className="group relative inline-flex w-full items-center justify-center gap-2.5 h-12 px-8 rounded-full font-medium text-[14.5px] text-token-primary transition-all duration-200 hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
      style={{
        background: 'var(--login-cta-gradient)',
        boxShadow: 'var(--login-cta-shadow)',
        letterSpacing: '0.01em',
        fontFamily: 'var(--font-display)',
      }}
    >
      {loading ? (
        <span
          className="inline-block h-3.5 w-3.5 rounded-full border-2 border-token-subtle border-t-token-subtle animate-spin"
          aria-hidden
        />
      ) : (
        <Lock className="w-4 h-4" />
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
      role="alert" className="rounded-xl px-4 py-3 text-[13px]"
      style={{
        background: 'rgba(244, 63, 94, 0.08)',
        border: '1px solid rgba(244, 63, 94, 0.35)',
        color: 'var(--accent-fg-danger)',
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
  return <div className="cinema-form-content">{children}</div>;
}

interface LoginCardProps {
  username: string;
  password: string;
  error: string | null;
  loading: boolean;
  canSubmit: boolean;
  rememberUsername: boolean;
  ssoOptions: SsoLoginOption[];
  ssoLoading: boolean;
  passwordLoginDisabled: boolean;
  returnUrl: string;
  onError: (message: string) => void;
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
  ssoOptions,
  ssoLoading,
  passwordLoginDisabled,
  returnUrl,
  onError,
  onUsernameChange,
  onPasswordChange,
  onRememberChange,
  onSubmit,
}: LoginCardProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const buildSsoHref = (option: SsoLoginOption) => {
    if (!option.baseUrl || !option.appCode || !option.redirectUri) return '#';
    const baseUrl = normalizeAbsoluteHttpUrl(option.baseUrl, true);
    if (!baseUrl) return null;
    const state = createSsoState();
    sessionStorage.setItem(MIDUO_SSO_STATE_KEY, state);
    const callback = new URL(option.redirectUri, window.location.origin);
    callback.searchParams.set('returnUrl', returnUrl);
    callback.searchParams.set('ssoProvider', option.provider);
    const bridge = `/sso/bridge?appCode=${encodeURIComponent(option.appCode)}&redirect_uri=${encodeURIComponent(callback.toString())}&state=${encodeURIComponent(state)}`;
    const url = new URL('/login', baseUrl);
    url.searchParams.set('redirect', bridge);
    return url.toString();
  };
  const handleSsoClick = (event: MouseEvent<HTMLAnchorElement>, option: SsoLoginOption) => {
    event.preventDefault();
    if (ssoLoading) return;
    try {
      const href = buildSsoHref(option);
      if (!href) {
        onError('米多星球登录地址无效，请联系管理员检查 SSO 配置');
        return;
      }
      window.location.assign(href);
    } catch {
      onError('米多星球登录地址无效，请联系管理员检查 SSO 配置');
    }
  };
  return (
    <GlassCard>
      <Reveal delay={0}><div className="cinema-form-index"><span />身份资料确认</div></Reveal>
      <Reveal delay={60}><h2 className="cinema-form-heading">连接你的工作空间</h2></Reveal>
      <Reveal delay={120}><p className="cinema-form-description">{passwordLoginDisabled ? '使用企业单点登录，连接你的工作。' : '以你的身份，连接无限可能。'}</p></Reveal>

      {/* Form */}
      <div className="mt-7 grid gap-4">
        {!passwordLoginDisabled && (
          <>
            <Reveal delay={240}>
              <Field
                label="用户名"
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
                  className="mb-2 flex items-center justify-between text-[11px] uppercase text-token-secondary"
                  style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.2em' }}
                >
                  <span>密码</span>
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
                  className="relative flex items-center rounded-xl transition-colors focus-within:border-token-subtle"
                  style={{
                    background: 'var(--login-field-bg)',
                    border: '1px solid var(--login-border)',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                  }}
                >
                  <span className="pl-4 pr-1 text-token-secondary">
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
                    className="h-12 w-full bg-transparent px-4 text-[14.5px] text-token-primary placeholder:text-token-muted outline-none"
                    style={{ fontFamily: 'var(--font-body)' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    title={showPassword ? '隐藏密码' : '显示密码'}
                    className="mr-2 flex h-9 w-9 items-center justify-center rounded-lg text-token-secondary hover:text-token-secondary hover-bg-soft transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </label>
            </Reveal>

            <Reveal delay={340}>
              <label className="flex items-center gap-2 cursor-pointer select-none text-[12.5px] text-token-secondary hover:text-token-secondary transition-colors">
                <input
                  type="checkbox"
                  checked={rememberUsername}
                  onChange={(e) => onRememberChange(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer accent-current"
                />
                <span style={{ fontFamily: 'var(--font-body)' }}>记住用户名</span>
              </label>
            </Reveal>
          </>
        )}

        {error && (
          <Reveal delay={0}>
            <ErrorBar>{error}</ErrorBar>
          </Reveal>
        )}

        {!passwordLoginDisabled && (
          <Reveal delay={360}>
            <div className="mt-2">
              <PrimaryPill onClick={onSubmit} disabled={!canSubmit || loading} loading={loading}>
                {loading ? '正在确认身份…' : '开始身份确认'}
              </PrimaryPill>
            </div>
          </Reveal>
        )}

        {ssoOptions.length > 0 && (
          <Reveal delay={400}>
            <div className="grid gap-2">
              <div
                className="flex items-center gap-3 text-[11px] uppercase text-token-secondary"
                style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.16em' }}
              >
                <span className="h-px flex-1 bg-token-nested" />
                <span>SSO</span>
                <span className="h-px flex-1 bg-token-nested" />
              </div>
              {ssoOptions.map((option) => {
                const disabled = !option.baseUrl || !option.appCode || !option.redirectUri || !normalizeAbsoluteHttpUrl(option.baseUrl, true) || ssoLoading;
                return (
                  <a
                    key={option.provider}
                    href={disabled ? undefined : '#'}
                    onClick={disabled ? undefined : (event) => handleSsoClick(event, option)}
                    aria-disabled={disabled}
                    title={disabled ? '未配置登录地址' : option.label}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-token-subtle bg-token-nested px-4 text-[13.5px] font-medium text-token-secondary transition-all hover:border-token-subtle hover-bg-soft/[0.07] aria-disabled:pointer-events-none aria-disabled:opacity-45"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    <Lock className="h-4 w-4" />
                    {ssoLoading ? '正在登录' : option.label}
                  </a>
                );
              })}
            </div>
          </Reveal>
        )}

        {passwordLoginDisabled && ssoOptions.length === 0 && (
          <Reveal delay={420}>
            <ErrorBar>暂时没有可用的登录方式，请联系管理员恢复登录服务。</ErrorBar>
          </Reveal>
        )}

        {!passwordLoginDisabled && (
          <Reveal delay={ssoOptions.length > 0 ? 480 : 440}>
            <div
              className="mt-1 inline-flex items-center gap-2 text-[11.5px] text-token-secondary"
              style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.1em' }}
            >
              <Terminal className="w-3 h-3" />
              <span>使用你的企业账号安全登录</span>
            </div>
          </Reveal>
        )}
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
              className="text-[20px] font-medium text-token-primary"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
            >
              设置新密码
            </div>
            <div
              className="text-[12.5px] text-token-secondary"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              首次登录需要重置密码
            </div>
          </div>
        </div>
      </Reveal>

      <Reveal delay={60}>
        <div className="mb-5">
          <div className="cinema-form-index">首次登录 / 设置密码</div>
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
              background: 'var(--login-field-bg)',
              border: '1px solid var(--login-border)',
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
            className="self-start text-[12px] text-token-secondary hover:text-token-primary transition-colors"
            style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.14em' }}
          >
            ← BACK TO LOGIN
          </button>
        </Reveal>
      </div>
    </GlassCard>
  );
}
