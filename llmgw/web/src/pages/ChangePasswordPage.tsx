// 首登强制改密页：缺省 admin/admin 账号登录后强制在此设置新口令，改密成功前无法进入日志页。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui';

export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth();
  const navigate = useNavigate();

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword || !newPassword) {
      setError('请填写旧口令与新口令');
      return;
    }
    if (newPassword.length < 6) {
      setError('新口令至少 6 位');
      return;
    }
    if (newPassword === oldPassword) {
      setError('新口令不能与旧口令相同');
      return;
    }
    if (newPassword !== confirm) {
      setError('两次输入的新口令不一致');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await changePassword(oldPassword, newPassword);
    setSubmitting(false);
    if (res.success) {
      navigate('/', { replace: true });
    } else {
      setError(res.error?.message || '改密失败，请重试');
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
          width: 'min(420px, 100%)',
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
            <KeyRound size={20} />
          </span>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>设置新口令</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {user?.username ? `账号 ${user.username}` : '首次登录'} · 需修改初始口令后才能继续
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            marginTop: 14,
            fontSize: 12,
            color: 'var(--text-secondary)',
            background: 'var(--accent-soft)',
            borderRadius: 'var(--radius-sm)',
            padding: '10px 12px',
            lineHeight: 1.6,
          }}
        >
          <ShieldAlert size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
          <span>该控制台默认口令为 admin/admin。为避免公网弱口令暴露，请立即设置一个新口令。</span>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
          <label style={inputWrap}>
            <Lock size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              type="password"
              placeholder="旧口令"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </label>
          <label style={inputWrap}>
            <KeyRound size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              type="password"
              placeholder="新口令（至少 6 位）"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label style={inputWrap}>
            <KeyRound size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              type="password"
              placeholder="确认新口令"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
            {submitting ? '提交中…' : '设置新口令并进入'}
          </Button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button variant="ghost" size="sm" onClick={logout}>
            退出登录
          </Button>
        </div>
      </div>
    </div>
  );
}
