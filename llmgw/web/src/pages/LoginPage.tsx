// 独立登录页：用户名/密码 → POST /gw/auth/login → JWT 存 sessionStorage → 跳控制台首页。
import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Activity, ArrowLeft, BarChart3, Building2, KeyRound, Lock, Rocket, ShieldCheck, User } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { getHealth } from '@/lib/api';
import { Button } from '@/components/ui';

type ConsoleLocation = Pick<Location, 'hostname' | 'protocol'>;

export function resolveMapHomeHref(location: ConsoleLocation = window.location): string {
  if (location.hostname.endsWith('.ebcone.net') && location.hostname !== 'map.ebcone.net') {
    return `${location.protocol}//map.ebcone.net/`;
  }

  const firstDot = location.hostname.indexOf('.');
  if (firstDot < 0) return '/';

  const hostPrefix = location.hostname.slice(0, firstDot);
  const gatewaySuffix = '-llmgw-web';
  if (!hostPrefix.endsWith(gatewaySuffix)) return '/';

  const mapHost = `${hostPrefix.slice(0, -gatewaySuffix.length)}${location.hostname.slice(firstDot)}`;
  return `${location.protocol}//${mapHost}/`;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthState, setHealthState] = useState<'checking' | 'ok' | 'unavailable'>('checking');

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
    ? 'Gateway 服务正常'
    : healthState === 'checking'
      ? '正在检查 Gateway 服务'
      : '暂时无法确认服务状态';

  return (
    <main className="lg-login-page">
      <section className="lg-login-shell" aria-labelledby="llmgw-login-title">
        <div className="lg-login-intro">
          <div className="lg-login-brand">
            <span className="lg-login-brand-icon" aria-hidden="true"><Activity size={21} /></span>
            <div>
              <strong>LLM Gateway</strong>
              <span>独立租户控制台</span>
            </div>
          </div>

          <div className="lg-login-hero">
            <div className={`lg-login-health is-${healthState}`} role="status" aria-live="polite">
              <span className="lg-login-health-dot" />
              {healthCopy}
            </div>
            <h1 id="llmgw-login-title">登录后，查看属于你的租户数据</h1>
            <p>这里不是空白演示站。为了避免跨租户泄露，首页、请求、模型、密钥和费用只会在身份校验通过后出现。</p>
          </div>

          <div className="lg-login-capabilities" aria-label="登录后可用功能">
            <div><Rocket size={18} /><span><strong>快速接入</strong><small>生成应用密钥，网页内直接测试四种协议</small></span></div>
            <div><BarChart3 size={18} /><span><strong>使用与费用</strong><small>查看请求趋势、模型、用户和费用可信度</small></span></div>
            <div><ShieldCheck size={18} /><span><strong>租户隔离</strong><small>只展示会话所属租户的配置、日志与审计</small></span></div>
          </div>

          <a href={resolveMapHomeHref()} className="lg-login-back-link">
            <ArrowLeft size={15} />返回 MAP 首页
          </a>
        </div>

        <div className="lg-login-panel">
          <div className="lg-login-panel-heading">
            <span>租户工作区</span>
            <h2>登录 Gateway 控制台</h2>
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
          <p className="lg-login-security-note">MAP 账号与 Gateway 账号彼此独立。新环境首位管理员首次登录后需要设置自己的密码，请勿共享他人的账号或密钥。</p>
        </div>
      </section>
    </main>
  );
}
