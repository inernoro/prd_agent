import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { login } from '@/services';
import { Button } from '@/components/design/Button';

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.login);
  const isAuthed = useAuthStore((s) => s.isAuthenticated);
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin');
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
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="h-full w-full flex items-center justify-center"
      style={{
        background:
          'radial-gradient(900px 500px at 50% 45%, rgba(214, 178, 106, 0.12) 0%, transparent 65%), radial-gradient(800px 420px at 35% 60%, rgba(124, 252, 0, 0.08) 0%, transparent 60%), linear-gradient(135deg, var(--bg-base) 0%, #09090b 50%, var(--bg-elevated) 100%)',
      }}
    >
      <div
        className="w-[420px] rounded-[22px] p-8"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
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
            Mock 登录：默认账号 `admin` / `admin`（仅 ADMIN 允许）
          </div>
        </div>
      </div>
    </div>
  );
}
