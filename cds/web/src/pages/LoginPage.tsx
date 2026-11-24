import { MotionLink as Link, useSurfaceNavigate as useNavigate } from '@/components/layout/RouteMotion';
import { AuthPageFrame, AuthFormSkeleton } from '@/components/skeletons/AuthPageSkeleton';
/*
 * LoginPage — CDS 控制台的唯一认证入口。
 *
 * 设计哲学「一条线」(2026-07-04 v4,替换 v3 的拼贴式构图):
 *   CDS 的本质 = 你 push 一个分支,两分钟后它活了。
 *   于是整页只有一个视觉思想 —— 一条从 push 出发的部署光路,横贯页面,
 *   途经 push(0:00) → build(0:40) → live(2:00) 三个时间站点,终点没入
 *   登录卡:你的环境已经活了,登录领取。
 *   纪律:一块画布(无分屏无接缝)、一个光源、橙色只存在于这条线上(电流);
 *   不在线上的元素不许存在(星座/要点列表/双 vignette 已全部删除)。
 *
 * 认证逻辑与旧版完全一致：
 *   - 会话探测：已登录直接跳 redirect 目标，不闪登录框
 *   - 首次启动 bootstrap：零用户时表单变身"创建系统所有者账号"
 *   - 本地登录双端点回退（/api/auth/login → 404 → /api/login）
 *   - GitHub OAuth 入口
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { ArrowRight, Eye, EyeOff, Github, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { CdsGem } from '@/components/brand/CdsGem';
import { Button } from '@/components/ui/button';
import {
  apiUrl,
  exchangeTicketSso,
  fetchAuthPublicStatus,
  fetchBootstrapStatus,
  bootstrapFirstUser,
  fetchSessionAuthed,
  isChildPreviewCdsInstance,
} from '@/lib/api';
import { parseTicketSsoCallback } from '@/lib/ticket-sso-callback';
import { signInWithPasskey } from '@/lib/passkeys';

import { PreviewAccessFrame, PreviewLabel, WhyPreviewLogin, type PreviewLoginContext } from './PreviewAccessPage';

export function redirectTarget(): string {
  if (typeof window === 'undefined') return '/project-list';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('redirect') || '/project-list';
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f]|%5c/i.test(raw)) return '/project-list';
  // 绝不把目标指回登录路由本身 —— 否则已登录用户从 /login 跳 /login 是 no-op,
  // spinner 永远转、登录框永不出现(Bugbot Medium「Login redirect target loops」)。
  const path = raw.split(/[?#]/)[0];
  if (path === '/login') return '/project-list';
  // Fragments never reach the server. Its unauthenticated redirect preserves
  // the original fragment on /login, so carry it back to the internal target.
  // An explicitly encoded target fragment takes precedence.
  return raw.includes('#') || !params.get('redirect') ? raw : raw + window.location.hash;
}

function AuthForm({ preview }: { preview?: PreviewLoginContext }): JSX.Element {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 登录失败时卡片 shake 一次;onAnimationEnd 复位保证连续出错可重播。
  const [shake, setShake] = useState(false);
  // First-run bootstrap: when the system has zero users, the login form turns
  // into a "create the first system-owner account" form instead.
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [loginMethodsReady, setLoginMethodsReady] = useState(false);
  const [localLoginEnabled, setLocalLoginEnabled] = useState(false);
  const [githubLoginEnabled, setGithubLoginEnabled] = useState(false);
  const [passkeyEnabled, setPasskeyEnabled] = useState(false);
  const [ssoLogin, setSsoLogin] = useState<{ enabled: boolean; label: string }>({
    enabled: false,
    label: '使用 SSO 登录',
  });
  const [bootstrapName, setBootstrapName] = useState('');
  const target = useMemo(() => redirectTarget(), []);
  const githubLoginHref = useMemo(() => apiUrl(`/api/auth/github/login?redirect=${encodeURIComponent(target)}`), [target]);

  useEffect(() => {
    let alive = true;
    fetchAuthPublicStatus()
      .then((s) => {
        if (!alive) return;
        setLocalLoginEnabled(s.loginMethods.local);
        setGithubLoginEnabled(s.loginMethods.github);
        setPasskeyEnabled(s.loginMethods.passkey === true && Boolean(window.PublicKeyCredential));
        setSsoLogin({
          enabled: s.loginMethods.sso === true && s.sso?.enabled === true,
          label: s.sso?.label || '使用 SSO 登录',
        });
        setLoginMethodsReady(true);
      })
      .catch(() => {
        if (!alive) return;
        // 旧版 CDS 可能没有 public-status；保留原有本地登录回退能力。
        setLocalLoginEnabled(true);
        setGithubLoginEnabled(false);
        setSsoLogin({ enabled: false, label: '使用 SSO 登录' });
        setLoginMethodsReady(true);
      });
    fetchBootstrapStatus()
      .then((s) => { if (alive) setNeedsBootstrap(s.needsBootstrap); })
      .catch(() => { /* endpoint absent in non-github modes — ignore */ })
      .finally(() => { if (alive) setBootstrapReady(true); });
    return () => { alive = false; };
  }, []);

  const showLocalLogin = needsBootstrap || localLoginEnabled;
  const hasExternalLogin = ssoLogin.enabled || githubLoginEnabled || passkeyEnabled;

  function goToTarget() {
    // Server endpoints (including the cluster login handoff) must reach Express.
    // Dashboard routes retain SPA navigation and their view transition.
    if (target.startsWith('/api/') || target.split(/[?#]/)[0] === '/preview/authorize' || /\.html(?:$|[?#])/i.test(target)) {
      window.location.assign(target);
    } else {
      navigate(target, { replace: true, viewTransition: true });
    }
  }

  async function signInPasskey() {
    setError('');
    setBusy(true);
    try {
      await signInWithPasskey();
      goToTarget();
    } catch {
      setError('通行密钥登录未完成，请重试或使用其他登录方式。');
      setShake(true);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (needsBootstrap) {
        await bootstrapFirstUser({ username, password, name: bootstrapName || undefined });
        goToTarget();
        return;
      }
      // 统一本地登录端点优先；404 时回退 legacy basic-auth /api/login，
      // 保证旧版服务和单用户 CDS_USERNAME 部署仍可用。
      let res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 404) {
        res = await fetch(apiUrl('/api/login'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username, password }),
        });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = typeof body?.error === 'string' ? body.error : '账号或密码不正确';
        throw new Error(message);
      }
      goToTarget();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setShake(true);
    } finally {
      setBusy(false);
    }
  }

  if (!loginMethodsReady || !bootstrapReady) return <AuthFormSkeleton />;

  if (preview && !needsBootstrap) {
    const previewAccount = <form onSubmit={submit} aria-busy={busy}>
      <small>本预览单独生成的账号用于自动化测试和运维排障。</small>
      <label>预览用户名<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label>
      <label>预览密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>
      {error && <p className="pv-error" role="alert">预览专用账号校验失败。{ssoLogin.enabled ? '可用 CDS 账号继续。' : '请核对本预览的账号和密码。'}</p>}
      <button type="submit" className={ssoLogin.enabled ? 'pv-secondary' : 'pv-primary'} disabled={busy}>{busy ? '正在验证…' : '用预览专用账号登录'}</button>
    </form>;
    return <article className="pv-card">
      <PreviewLabel {...preview} />
      <h1>登录这个分支预览</h1>
      {ssoLogin.enabled && <>
        <a className="pv-primary" href={apiUrl(`/api/auth/sso/start?redirect=${encodeURIComponent(target)}`)}><KeyRound />用 CDS 账号继续</a>
        <small>用平时的 CDS 账号确认身份。已登录 CDS 时，页面会直接返回预览。</small>
      </>}
      <WhyPreviewLogin policyUrl={preview.policyUrl} />
      {showLocalLogin && (ssoLogin.enabled
        ? <details className="pv-native"><summary>其他方式 · 预览专用账号</summary>{previewAccount}</details>
        : previewAccount)}
    </article>;
  }

  return (
    <form
      onSubmit={submit}
      className={`cds-auth-card${shake ? ' cds-auth-card--shake' : ''}`}
      aria-busy={busy}
      onAnimationEnd={(event) => {
        if (event.animationName === 'cds-auth-shake') setShake(false);
      }}
    >
      <div className="cds-auth-mark" aria-hidden>
        {/* 登录卡是品牌标的主舞台:一次性逐面组装入场,之后切面轮流闪辉 */}
        <CdsGem mode="brand" entrance className="h-10 w-10" />
        <span className="cds-auth-secure">
          <span className="cds-auth-pulse" />
          same-origin · secure
        </span>
      </div>
      <h1 className="cds-auth-title">{needsBootstrap ? '创建管理员账号' : '登录 CDS 控制台'}</h1>
      <p className="cds-auth-sub">
        {needsBootstrap
          ? '首次启动：先创建系统所有者账号，随后直接进入控制台。'
          : showLocalLogin
            ? '使用操作员账号进入分支预览控制台。'
            : '使用已配置的身份提供方进入分支预览控制台。'}
      </p>



      {loginMethodsReady && showLocalLogin ? <div className="cds-auth-fields">
        <label className="cds-auth-field">
          <span>用户名</span>
          <input
            className="cds-auth-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
            placeholder="操作员用户名"
          />
        </label>
        {needsBootstrap ? (
          <label className="cds-auth-field">
            <span>
              显示名称
              <em>可选</em>
            </span>
            <input
              className="cds-auth-input"
              value={bootstrapName}
              onChange={(event) => setBootstrapName(event.target.value)}
              autoComplete="name"
              placeholder="展示给团队成员的名字"
            />
          </label>
        ) : null}
        <label className="cds-auth-field">
          <span>密码</span>
          <span className="cds-auth-input-wrap">
            <input
              className="cds-auth-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
              required
              minLength={needsBootstrap ? 8 : undefined}
              placeholder={needsBootstrap ? '至少 8 位' : '密码'}
            />
            <button
              type="button"
              className="cds-auth-eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </button>
          </span>
        </label>
      </div> : null}

      {error ? (
        <div className="cds-auth-error" role="alert">
          {error}
        </div>
      ) : null}

      {loginMethodsReady && showLocalLogin ? (
        <Button type="submit" disabled={busy} className="cds-auth-submit h-10">
          {busy ? <Loader2 className="animate-spin" /> : null}
          {busy
            ? (needsBootstrap ? '正在创建…' : '正在验证…')
            : (needsBootstrap ? '创建并进入控制台' : '登录')}
          {busy ? null : <ArrowRight />}
        </Button>
      ) : null}

      {!loginMethodsReady || needsBootstrap || !hasExternalLogin ? null : (
        <>
          {showLocalLogin ? (
            <div className="cds-auth-divider" aria-hidden>
              <span>或</span>
            </div>
          ) : null}
          <div className="grid gap-2">
            {passkeyEnabled ? (
              <Button type="button" variant="outline" className="cds-auth-github" disabled={busy}
                onClick={() => { void signInPasskey(); }}>
                <ShieldCheck />
                使用通行密钥登录
              </Button>
            ) : null}
            {ssoLogin.enabled ? (
              <Button asChild type="button" variant="outline" className="cds-auth-github">
                <a href={apiUrl(`/api/auth/sso/start?redirect=${encodeURIComponent(target)}`)}>
                  <KeyRound />
                  {ssoLogin.label}
                </a>
              </Button>
            ) : null}
            {githubLoginEnabled ? (
              <Button asChild type="button" variant="outline" className="cds-auth-github">
                <a href={githubLoginHref}>
                  <Github />
                  使用 GitHub 登录
                </a>
              </Button>
            ) : null}
          </div>
        </>
      )}

      <p className="cds-auth-hint">同源会话 Cookie · 凭据不落本地存储</p>
    </form>
  );
}

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  // 'checking' = 正在探会话态;'anon' = 未登录,展示登录框。已登录则直接跳走,
  // 不会停留在此状态。探测期间用同轮廓骨架占位,避免先闪一下登录框再跳转。
  const [authPhase, setAuthPhase] = useState<'checking' | 'anon'>('checking');
  const [preview, setPreview] = useState<PreviewLoginContext | undefined>(() => isChildPreviewCdsInstance() ? {} : undefined);
  useEffect(() => {
    let mounted = true;
    void fetchAuthPublicStatus().then(status => {
      if (mounted && (status.preview || status.sso?.providerId === 'cds-preview')) setPreview(status.preview ?? {});
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);
  // 登录成功后要跳的内容页(默认控制台)是 lazy chunk:登录页一挂载就预取,
  // 提交成功 navigate 时不会触发 Suspense 白屏,配合 viewTransition 丝滑进内容页。
  useEffect(() => {
    void import('@/pages/ProjectListPage');
    void import('@/pages/HomePage');
  }, []);

  // 直接访问 /login 时,若会话 cookie 仍有效,跳过登录框直达目标页
  // (默认 /project-list,或 ?redirect= 指定的合法内部路径)。
  useEffect(() => {
    let alive = true;
    if (new URLSearchParams(window.location.search).get('choose_account') === '1') {
      setAuthPhase('anon');
      return;
    }
    fetchSessionAuthed().then((ok) => {
      if (!alive) return;
      if (!ok) {
        setAuthPhase('anon');
        return;
      }
      const target = redirectTarget();
      // 兜底:若目标解析后仍等于当前路径,navigate 是 no-op,骨架会卡死 ——
      // 这种情况直接落到登录框(redirectTarget 已排除 /login,这里只是双保险)。
      if (target.split(/[?#]/)[0] === window.location.pathname) {
        setAuthPhase('anon');
        return;
      }
      if (target.startsWith('/api/') || target.split(/[?#]/)[0] === '/preview/authorize' || /\.html(?:$|[?#])/i.test(target)) {
        // Authenticated visits also need the server to perform the handoff.
        window.location.assign(target);
      } else {
        navigate(target, { replace: true, viewTransition: true });
      }
    });
    return () => {
      alive = false;
    };
  }, [navigate]);

  const content = authPhase === 'checking' ? <AuthFormSkeleton /> : <AuthForm preview={preview} />;
  return preview ? <PreviewAccessFrame>{content}</PreviewAccessFrame> : <AuthPageFrame>{content}</AuthPageFrame>;
}

function readSsoCallback(): { code: string; state: string } | null {
  return parseTicketSsoCallback(window.location.hash);
}

export function TicketSsoPage(): JSX.Element {
  const navigate = useNavigate();
  const [callback] = useState(readSsoCallback);
  const [error, setError] = useState('');
  const exchangeRef = useRef<ReturnType<typeof exchangeTicketSso> | null>(null);

  useEffect(() => {
    let alive = true;
    if (!callback) {
      setError('SSO 登录链接无效或已过期，请返回登录页重新发起。');
      return () => { alive = false; };
    }
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    exchangeRef.current ||= exchangeTicketSso(callback);
    void exchangeRef.current
      .then((result) => {
        if (!alive) return;
        const target = result.redirect || '/project-list';
        if (target.startsWith('/api/') || target.split(/[?#]/)[0] === '/preview/authorize' || /\.html(?:$|[?#])/i.test(target)) {
          window.location.assign(target);
          return;
        }
        navigate(target, { replace: true, viewTransition: true });
      })
      .catch(() => {
        if (alive) setError('SSO 授权未完成，一次性链接可能已使用或已过期。');
      });
    return () => { alive = false; };
  }, [callback, navigate]);

  return (
    <main className="cds-auth-page cds-grain">
      <section className="mx-auto flex min-h-screen max-w-lg items-center px-6">
        <div className="cds-auth-card w-full text-center" role={error ? 'alert' : 'status'} aria-live="polite">
          <div className="cds-auth-mark justify-center" aria-hidden>
            {error ? <ShieldCheck className="h-8 w-8" /> : <Loader2 className="h-8 w-8 animate-spin" />}
          </div>
          <h1 className="cds-auth-title">{error ? '需要重新发起登录' : '正在安全登录 CDS'}</h1>
          <p className="cds-auth-sub">
            {error || '正在核验一次性授权并建立会话，完成后将进入主分支项目列表。'}
          </p>
          {error ? (
            <Button asChild className="mt-5">
              <Link to="/login" replace>返回登录页</Link>
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
