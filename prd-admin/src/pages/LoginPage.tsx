import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { getAdminAuthzMe, login, resetPassword } from '@/services';
import { Button } from '@/components/design/Button';
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import { backdropMotionController, useBackdropMotionSnapshot } from '@/lib/backdropMotionController';

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
  const [loading, setLoading] = useState(false);
  const { count: backdropCount, pendingStopId } = useBackdropMotionSnapshot();
  // 登录页默认持续动（更符合登录页氛围）；若 controller 正在刹车/运行，则由其接管
  const shouldRun: boolean | undefined = backdropCount > 0 ? true : pendingStopId ? false : undefined;

  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
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
    if (isAuthed) navigate('/', { replace: true });
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
    // 让主页面承接登录页背景：动 2 秒后冻结
    try {
      sessionStorage.setItem('prd-postlogin-fx', '1');
    } catch {
      // ignore
    }
    navigate('/', { replace: true });
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
    <div className="prd-login-root relative h-full w-full overflow-hidden">
      <RecursiveGridBackdrop
        className="absolute inset-0"
        // 与 thirdparty/ref/递归网络.html 一致：rot += 0.02deg @60fps => 1.2deg/s
        speedDegPerSec={1.2}
        shouldRun={shouldRun}
        stopRequestId={pendingStopId || null}
        stopBrakeMs={2000}
        onFullyStopped={(id) => {
          if (!id) return;
          backdropMotionController.markStopped(id);
        }}
        persistKey="prd-recgrid-rot"
        // 必须 readwrite：登出回登录页要读取主页面保存的角度，实现"续着以前的状态"
        persistMode="readwrite"
        // 登录页 idle 也希望更"深"：除非明确刹车（shouldRun===false），否则用实色
        strokeRunning={shouldRun === false ? 'rgba(165, 180, 252, 0.30)' : 'rgba(165, 180, 252, 1)'}
        strokeBraking={'rgba(165, 180, 252, 0.30)'}
        brakeStrokeFadeMs={2000}
      />

      {/* 隔离层：阻断 backdrop-filter 对 Canvas 动画的实时采样，避免模糊重算导致卡顿 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'rgba(5, 5, 7, 0.15)',
          // 关键：这层有自己的 will-change，形成独立合成层，让上层 backdrop-filter 采样到的是这个静态层
          willChange: 'transform',
          transform: 'translateZ(0)',
        }}
      />

      {/* overlay: lift behind the card */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(820px 620px at 50% 46%, rgba(99, 102, 241, 0.10) 0%, transparent 66%), radial-gradient(900px 720px at 48% 56%, rgba(92, 134, 255, 0.06) 0%, transparent 70%)',
          opacity: 0.9,
        }}
      />

      <div className="relative z-10 h-full w-full flex items-center justify-center px-6 py-10">
        <div className="prd-login-card w-full max-w-[440px] rounded-[22px] p-8">
          {!showResetPassword ? (
            // 登录界面
            <>
              <div className="flex items-center gap-4">
                <div
                  className="h-12 w-12 rounded-[14px] flex items-center justify-center text-[12px] font-extrabold"
                  style={{ background: 'linear-gradient(135deg, var(--accent-gold) 0%, var(--accent-gold-2) 100%)', color: '#ffffff' }}
                >
                  MAP
                </div>
                <div className="min-w-0">
                  <div className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>MAP Admin</div>
                  <div className="text-sm" style={{ color: 'var(--text-muted)' }}>使用管理员账号登录</div>
                </div>
              </div>

              <div className="mt-8 grid gap-4">
                <label className="grid gap-2">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>用户名</span>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="h-11 w-full rounded-[14px] px-4 text-sm outline-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    placeholder="admin"
                    autoComplete="username"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>密码</span>
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11 w-full rounded-[14px] px-4 text-sm outline-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    placeholder="admin"
                    type="password"
                    autoComplete="current-password"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSubmit();
                    }}
                  />
                </label>

                {error && (
                  <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.95)' }}>
                    {error}
                  </div>
                )}

                <Button
                  onClick={onSubmit}
                  disabled={!canSubmit || loading}
                  className="w-full"
                  variant="primary"
                >
                  {loading ? '登录中...' : '登录'}
                </Button>

                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  默认管理员：admin / admin（首次登录后请修改密码）
                </div>
              </div>
            </>
          ) : (
            // 首次登录重置密码界面
            <>
              <div className="flex items-center gap-4">
                <div
                  className="h-12 w-12 rounded-[14px] flex items-center justify-center text-[12px] font-extrabold"
                  style={{ background: 'linear-gradient(135deg, var(--accent-gold) 0%, var(--accent-gold-2) 100%)', color: '#ffffff' }}
                >
                  MAP
                </div>
                <div className="min-w-0">
                  <div className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>设置新密码</div>
                  <div className="text-sm" style={{ color: 'var(--text-muted)' }}>首次登录需要重置密码</div>
                </div>
              </div>

              <div className="mt-8 grid gap-4">
                <label className="grid gap-2">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>新密码</span>
                  <input
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="h-11 w-full rounded-[14px] px-4 text-sm outline-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    placeholder="请输入新密码"
                    type="password"
                    autoComplete="new-password"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>确认密码</span>
                  <input
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="h-11 w-full rounded-[14px] px-4 text-sm outline-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    placeholder="请再次输入新密码"
                    type="password"
                    autoComplete="new-password"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onResetPassword();
                    }}
                  />
                </label>

                {resetError && (
                  <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.95)' }}>
                    {resetError}
                  </div>
                )}

                <Button
                  onClick={onResetPassword}
                  disabled={!canResetSubmit || resetLoading}
                  className="w-full"
                  variant="primary"
                >
                  {resetLoading ? '设置中...' : '确认设置'}
                </Button>

                <button
                  onClick={onBackToLogin}
                  className="text-sm underline"
                  style={{ color: 'var(--text-muted)' }}
                >
                  返回登录
                </button>

                {newPassword && (
                  <div className="grid gap-1 text-xs">
                    {passwordRules.map((rule) => {
                      const pass = rule.test(newPassword);
                      return (
                        <div key={rule.key} style={{ color: pass ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.8)' }}>
                          {pass ? '✓' : '✗'} {rule.label}
                        </div>
                      );
                    })}
                  </div>
                )}
                {!newPassword && (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    密码要求：8-128 位，需包含字母和数字
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
