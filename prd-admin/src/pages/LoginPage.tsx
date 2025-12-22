import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { login } from '@/services';
import { Button } from '@/components/design/Button';
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import { emitBackdropBusyStopped } from '@/lib/backdropBusy';
import { backdropMotionController, useBackdropMotionSnapshot } from '@/lib/backdropMotionController';

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.login);
  const isAuthed = useAuthStore((s) => s.isAuthenticated);
  const [loading, setLoading] = useState(false);
  const { count: backdropCount, pendingStopId } = useBackdropMotionSnapshot();
  // 登录页默认应“持续动”（原始体验）；只有当外部明确进入运行/刹车态时才由 controller 接管
  const shouldRun: boolean | undefined = backdropCount > 0 ? true : pendingStopId ? false : undefined;

  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(() => Boolean(username.trim() && password.trim()), [username, password]);

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
      setAuth(res.data.user, res.data.accessToken);
      // 让主页面承接登录页背景：动 2 秒后冻结
      try {
        sessionStorage.setItem('prd-postlogin-fx', '1');
      } catch {
        // ignore
      }
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="prd-login-root relative h-full w-full overflow-hidden">
      <RecursiveGridBackdrop
        className="absolute inset-0"
        speedDegPerSec={2.2}
        shouldRun={shouldRun}
        stopRequestId={pendingStopId || null}
        stopBrakeMs={2000}
        onFullyStopped={(id) => {
          if (!id) return;
          emitBackdropBusyStopped(id);
          backdropMotionController.markStopped(id);
        }}
        persistKey="prd-recgrid-rot"
        persistMode="write"
        // 登录页希望“更实更深”：默认（shouldRun=undefined）也用更实的线条
        strokeRunning={shouldRun === false ? 'rgba(231, 206, 151, 0.30)' : 'rgba(231, 206, 151, 1)'}
        strokeBraking={'rgba(231, 206, 151, 0.30)'}
        brakeStrokeFadeMs={2000}
      />

      {/* overlay: lift behind the card */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(820px 620px at 50% 46%, rgba(214, 178, 106, 0.10) 0%, transparent 66%), radial-gradient(900px 720px at 48% 56%, rgba(92, 134, 255, 0.06) 0%, transparent 70%)',
          opacity: 0.9,
        }}
      />

      <div className="relative z-10 h-full w-full flex items-center justify-center px-6 py-10">
        <div className="prd-login-card w-full max-w-[440px] rounded-[22px] p-8">
          <div className="flex items-center gap-4">
            <div
              className="h-12 w-12 rounded-[14px] flex items-center justify-center text-[12px] font-extrabold"
              style={{ background: 'linear-gradient(135deg, var(--accent-gold) 0%, var(--accent-gold-2) 100%)', color: '#1a1206' }}
            >
              PRD
            </div>
            <div className="min-w-0">
              <div className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>PRD Admin</div>
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
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
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
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
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
        </div>
      </div>
    </div>
  );
}
