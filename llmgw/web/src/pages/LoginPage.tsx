// 独立登录页：用户名/密码 → POST /gw/auth/login → JWT 存 localStorage（7 天 + 用后自动续期）→ 跳控制台首页。
import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Activity, ArrowLeft, Building2, KeyRound, Lock, User } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { getHealth } from '@/lib/api';
import { resolveMapHomeHref, usePlatformMapHome } from '@/lib/mapNavigation';
import { Button } from '@/components/ui';
import './LoginPage.css';

export { resolveMapHomeHref } from '@/lib/mapNavigation';

export function LoginPage() {
  const { login, sessionExpiredReason } = useAuth();
  // 「返回 MAP」的地址等 healthz 回来才准，订阅一下让它到达时重算。
  usePlatformMapHome();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthState, setHealthState] = useState<'checking' | 'ok' | 'unavailable'>('checking');
  // 被动踢回登录页时说清原因和去向，用户不会以为自己「被莫名其妙登出」。
  const expiredNotice = sessionExpiredReason === 'revoked'
    ? '账号的租户成员关系或角色已变更，原登录状态已作废，请重新登录。'
    : sessionExpiredReason === 'expired'
      ? '登录状态已过期，请重新登录。登录后会回到你刚才的页面。'
      : null;

  useEffect(() => {
    let active = true;
    getHealth()
      .then((res) => {
        if (active) setHealthState(res.success && res.data?.status === 'ok' ? 'ok' : 'unavailable');
      })
      .catch(() => {
        if (active) setHealthState('unavailable');
      });
    return () => {
      active = false;
    };
  }, []);

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

  const healthCopy = healthState === 'ok'
    ? 'Gateway 服务可连接'
    : healthState === 'checking'
      ? '正在检查 Gateway 服务'
      : '暂时无法确认服务状态';

  return (
    <main className="lg-login-page lg-login-task">
      <section className="lg-login-shell" aria-labelledby="llmgw-login-title">
        <div className="lg-login-intro">
          <div className="lg-login-brand">
            <span className="lg-login-brand-icon" aria-hidden="true"><Activity size={21} /></span>
            <div>
              <strong>LLM Gateway</strong>
              <span>独立租户控制台</span>
            </div>
          </div>

          <h1 id="llmgw-login-title">登录 LLM Gateway</h1>
          <div className={`lg-login-health is-${healthState}`} role="status" aria-live="polite">
            <span className="lg-login-health-dot" />{healthCopy}
          </div>
        </div>

        <div className="lg-login-panel">
          <div className="lg-login-panel-heading">
            <p>使用租户管理员为你创建的控制台账号。</p>
          </div>

          <form onSubmit={submit} className="lg-login-form">
            <label htmlFor="llmgw-username">用户名</label>
            <div className="lg-login-input-wrap">
              <User size={17} aria-hidden="true" />
              <input
                id="llmgw-username"
                placeholder="输入用户名"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <label htmlFor="llmgw-password">密码</label>
            <div className="lg-login-input-wrap">
              <Lock size={17} aria-hidden="true" />
              <input
                id="llmgw-password"
                type="password"
                placeholder="输入密码"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {!error && expiredNotice ? (
              <div className="lg-login-notice" role="status">{expiredNotice}</div>
            ) : null}

            {error ? (
              <div className="lg-login-error" role="alert">{error}</div>
            ) : null}

            <Button type="submit" variant="primary" size="md" disabled={submitting} className="lg-login-submit">
              {submitting ? '正在验证账号…' : '进入租户工作区'}
            </Button>
          </form>

          <div className="lg-login-account-help">
            <strong>没有控制台账号？</strong>
            <div><Building2 size={15} /><span>请让租户 Owner 或 Admin 在“团队与成员”中添加你。</span></div>
            <div><KeyRound size={15} /><span><code>gwk_</code> 是应用调用密钥，不能登录控制台。</span></div>
          </div>
          <p className="lg-login-security-note">MAP 与 Gateway 账号独立。使用 MAP 登录时，请从 MAP 的网关入口发起。请勿共享账号或密钥。</p>
          <a href={resolveMapHomeHref()} className="lg-login-back-link"><ArrowLeft size={15} />返回 MAP</a>
        </div>
      </section>
    </main>
  );
}
