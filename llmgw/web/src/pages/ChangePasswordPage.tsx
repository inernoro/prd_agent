import { gatewayLoginDestination } from '@/components/entry/quickstartArrival';
// 首登强制改密页：使用管理员提供的初始口令验证，改密成功前无法进入控制台。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { isPasswordChangeUncertain } from '@/lib/passwordRecovery';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui';
import { FIELD_LABEL } from '@/lib/typography';
import './ChangePasswordPage.css';

export function ChangePasswordPage() {
  const { user, tenant, changePassword, logout } = useAuth();
  const navigate = useNavigate();

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 「改成功了但会话到期」——既不是失败也不能直接进首页，单独一种终态。
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || outcomeUnknown || notice) return;
    if (!oldPassword || !newPassword) {
      setError('请填写旧口令与新口令');
      return;
    }
    if (newPassword.length < 12) {
      setError('新口令至少 12 位');
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
    let res: Awaited<ReturnType<typeof changePassword>>;
    try { res = await changePassword({ oldPassword, newPassword }); }
    catch { res = { success: false, data: null, error: { code: 'NETWORK_ERROR', message: '口令修改响应读取中断' } }; }
    finally { setSubmitting(false); }
    if (res.success) {
      // 「改成功了但会话到期」后端回的是 success + requiresRelogin（报失败会让用户
      // 拿着已经作废的旧口令反复重试）。此时不能跳首页——会话已经没了，
      // 跳过去只会被路由守卫弹回登录页，用户完全不知道口令到底改没改。
      if (res.data?.requiresRelogin) {
        // 不能在这里直接 logout：一登出路由守卫立刻把页面换成登录页，
        // 这条「到底改没改成功」的提示用户一眼都看不到。留在原地告诉他，
        // 由他点「退出登录」离开。
        setNotice('口令已修改成功。原会话已到期，请用新口令重新登录。');
        return;
      }
      navigate(gatewayLoginDestination(null, tenant), { replace: true });
    } else {
      if (isPasswordChangeUncertain(res.error?.code)) setOutcomeUnknown(true);
      else setError(res.error?.message || '修改被拒绝');
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
    height: 44,
  };
  const inputStyle: React.CSSProperties = {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--text-primary)',
    fontSize: 'var(--fs-body)',
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
            <h1 style={{ margin: 0, fontSize: 'var(--fs-metric)', fontWeight: 700, color: 'var(--text-primary)' }}>设置新口令</h1>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>
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
            fontSize: 'var(--fs-caption)',
            color: 'var(--text-secondary)',
            background: 'var(--accent-soft)',
            borderRadius: 'var(--radius-sm)',
            padding: '10px 12px',
            lineHeight: 1.6,
          }}
        >
          <ShieldAlert size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
          <span>请使用管理员单独提供的初始口令完成验证，再设置只属于你自己的新口令。不要共享口令，也不要把应用接入密钥当作登录口令。</span>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
          <label className="lg-forced-password-field" style={{ ...FIELD_LABEL, display: 'grid', gap: 6 }}><span>旧口令</span><span style={inputWrap}>
            <Lock size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              disabled={submitting || outcomeUnknown || !!notice}
              type="password"
              placeholder="旧口令"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </span></label>
          <label className="lg-forced-password-field" style={{ ...FIELD_LABEL, display: 'grid', gap: 6 }}><span>新口令（至少 12 位）</span><span style={inputWrap}>
            <KeyRound size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              disabled={submitting || outcomeUnknown || !!notice}
              type="password"
              placeholder="新口令（至少 12 位）"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </span></label>
          <label className="lg-forced-password-field" style={{ ...FIELD_LABEL, display: 'grid', gap: 6 }}><span>确认新口令</span><span style={inputWrap}>
            <KeyRound size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              style={inputStyle}
              disabled={submitting || outcomeUnknown || !!notice}
              type="password"
              placeholder="确认新口令"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </span></label>

          {outcomeUnknown ? <div role="alert" style={{ color: 'var(--err)' }}>修改结果未确认，可能已生效。请用本次设置的新口令重新登录核实，勿重复提交。</div> : null}
          {notice ? (
            <div
              style={{
                fontSize: 'var(--fs-caption)',
                color: 'var(--ok)',
                background: 'var(--ok-bg)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
              }}
            >
              {notice}
            </div>
          ) : null}

          {error ? (
            <div
              style={{
                fontSize: 'var(--fs-caption)',
                color: 'var(--err)',
                background: 'var(--err-bg)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
              }}
            >
              {error}
            </div>
          ) : null}

          <Button type="submit" variant="primary" size="md" disabled={submitting || outcomeUnknown || !!notice} style={{ marginTop: 4, minHeight: 44 }}>
            {submitting ? '提交中…' : '设置新口令并进入'}
          </Button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button variant="ghost" size="sm" onClick={logout} style={{ minHeight: 44 }}>
            {outcomeUnknown ? '重新登录核实' : '退出登录'}
          </Button>
        </div>
      </div>
    </div>
  );
}
