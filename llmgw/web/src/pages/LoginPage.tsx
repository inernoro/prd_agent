// 独立登录页：用户名/密码 → POST /gw/auth/login → JWT 存 sessionStorage → 跳观测主页。
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Activity, Lock, User } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await login(username.trim(), password);
    setSubmitting(false);
    if (res.success) {
      navigate(from, { replace: true });
    } else {
      setError(res.error?.message || '登录失败，请检查账号密码');
    }
  };

  const inputWrap: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'var(--bg-input)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)',
    padding: '0 12px',
    height: 42,
  };
  const inputStyle: React.CSSProperties = {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--text-primary)',
    fontSize: 14,
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg-page)',
      }}
    >
      <div
        style={{
          width: 'min(400px, 100%)',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-card)',
          padding: 32,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
            }}
          >
            <Activity size={20} />
          </span>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>LLM 网关观测台</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>请登录以查看请求日志</div>
          </div>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 22 }}>
          <label style={inputWrap}>
            <User size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              placeholder="用户名"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label style={inputWrap}>
            <Lock size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              type="password"
              placeholder="密码"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--err)',
                background: 'var(--err-bg)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
              }}
            >
              {error}
            </div>
          ) : null}

          <Button type="submit" variant="primary" size="md" disabled={submitting} style={{ marginTop: 4 }}>
            {submitting ? '登录中…' : '登 录'}
          </Button>
        </form>

        <div style={{ marginTop: 18, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          独立观测台账号体系。后端端点约定：POST {`{API_BASE}`}/auth/login，返回 {`{ success, data: { token } }`}。
        </div>
      </div>
    </div>
  );
}
