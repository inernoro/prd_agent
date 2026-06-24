import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Github, Home, KeyRound, Loader2, Server, Shield, Terminal, UserRound } from 'lucide-react';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { ShinyText } from '@/components/effects/ShinyText';
import { Button } from '@/components/ui/button';
import { apiUrl, fetchBootstrapStatus, bootstrapFirstUser, fetchSessionAuthed } from '@/lib/api';
import './HomePage.css';

function redirectTarget(): string {
  if (typeof window === 'undefined') return '/project-list';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('redirect') || '/project-list';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/project-list';
  return raw;
}

const LoginBranchGlyph = (props: { className?: string }) => (
  <svg className={props.className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="9" r="2.4" />
    <path d="M6 8.4v7.2M8.2 7.2 16 8.6M18 11.2c0 4-4 4.4-8.4 4.6" />
  </svg>
);

export function CdsAccessMorphBoard(props: { target?: string; onHome?: () => void }): JSX.Element {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // First-run bootstrap: when the system has zero users, the login form turns
  // into a "create the first system-owner account" form instead.
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [bootstrapName, setBootstrapName] = useState('');
  const target = useMemo(() => props.target ?? redirectTarget(), [props.target]);
  const githubLoginHref = useMemo(() => apiUrl(`/api/auth/github/login?redirect=${encodeURIComponent(target)}`), [target]);

  useEffect(() => {
    let alive = true;
    fetchBootstrapStatus()
      .then((s) => { if (alive) setNeedsBootstrap(s.needsBootstrap); })
      .catch(() => { /* endpoint absent in non-github modes — ignore */ });
    return () => { alive = false; };
  }, []);

  function goToTarget() {
    if (/\.html(?:$|[?#])/i.test(target)) {
      window.location.assign(target);
    } else {
      navigate(target, { replace: true, viewTransition: true });
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (needsBootstrap) {
        // Create the first local system-owner account, then enter the console.
        await bootstrapFirstUser({ username, password, name: bootstrapName || undefined });
        goToTarget();
        return;
      }
      // Try the github-mode local-login route first; fall back to the legacy
      // basic-auth /api/login so single-user CDS_USERNAME deployments still work.
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
        const message = typeof body?.error === 'string' ? body.error : 'Access denied';
        throw new Error(message);
      }
      // Auth cookie is already set by the response above.
      // - Clean React route → SPA navigate (no bundle re-download) + view transition.
      //   `target` is validated internal in redirectTarget(); `replace` drops /login from history.
      // - Legacy server path (`/settings.html?project=…`, `/index.html?project=…` 等) →
      //   hard-load so the Express legacy→React redirects rewrite it; SPA navigate would let
      //   React Router treat `/settings.html` as unknown and fall through to `/project-list`
      //   (Bugbot #741 Medium「Login SPA skips legacy redirects」).
      goToTarget();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="cdsh-login-morph-board">
      <div className="cdsh-login-board-head">
        <div className="cdsh-left">
          <LoginBranchGlyph className="h-10 w-10 text-white" />
          <span className="cdsh-login-branch cdsh-mono">access/auth-flow</span>
          <span className="cdsh-tag cdsh-mono">operator</span>
        </div>
        <span className="cdsh-login-live">
          <span className="cdsh-pulse" />
          secure
        </span>
      </div>

      <div className="cdsh-login-morph-canvas">
        <svg className="cdsh-login-morph-wires" viewBox="0 0 1000 640" preserveAspectRatio="none" aria-hidden>
          <path d="M320 246 H348 V144 H360" />
          <path d="M320 246 H348 V361 H360" />
          <path d="M640 144 H680" />
          <path d="M640 361 H680" />
          <path d="M500 212 V294" />
          <path d="M820 212 V294" />
          <path d="M500 429 V499" />
          <path d="M820 429 V470 H700 V499" />
        </svg>

        <div className="cdsh-node cdsh-login-operator-node cdsh-node-glow">
          <div className="cdsh-row">
            <span className="cdsh-ico"><LoginBranchGlyph /></span>
            <div><div className="cdsh-title">Operator</div><div className="cdsh-desc cdsh-mono">credentials required</div></div>
          </div>
          <div className="cdsh-status"><span className="cdsh-sdot" />Same-origin access gate</div>
        </div>

        <label className="cdsh-node cdsh-login-identity-node">
          <div className="cdsh-row">
            <span className="cdsh-ico"><UserRound /></span>
            <div><div className="cdsh-title">identity</div><div className="cdsh-desc cdsh-mono">{needsBootstrap ? 'new operator' : 'operator'}</div></div>
          </div>
          <span className="cdsh-login-inline-input">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              required
              className="cdsh-login-morph-input"
              placeholder="username"
            />
          </span>
        </label>

        {needsBootstrap ? (
          <label className="cdsh-node cdsh-login-session-node">
            <div className="cdsh-row">
              <span className="cdsh-ico"><UserRound /></span>
              <div><div className="cdsh-title">display</div><div className="cdsh-desc cdsh-mono">optional</div></div>
            </div>
            <span className="cdsh-login-inline-input">
              <input
                value={bootstrapName}
                onChange={(event) => setBootstrapName(event.target.value)}
                autoComplete="name"
                className="cdsh-login-morph-input"
                placeholder="display name"
              />
            </span>
          </label>
        ) : (
          <div className="cdsh-node cdsh-login-session-node" aria-hidden>
            <div className="cdsh-row">
              <span className="cdsh-ico"><Shield /></span>
              <div><div className="cdsh-title">session</div><div className="cdsh-desc cdsh-mono">same-origin cookie</div></div>
            </div>
            <div className="cdsh-status"><span className="cdsh-sdot" />No local secret</div>
          </div>
        )}

        <div className="cdsh-node cdsh-login-console-node" aria-hidden>
          <div className="cdsh-row">
            <span className="cdsh-ico"><Server /></span>
            <div><div className="cdsh-title">console</div><div className="cdsh-desc cdsh-mono">/project-list</div></div>
          </div>
          <div className="cdsh-status"><span className="cdsh-sdot" />Ready after auth</div>
        </div>

        <label className="cdsh-node cdsh-login-secret-node">
          <div className="cdsh-row">
            <span className="cdsh-ico"><KeyRound /></span>
            <div><div className="cdsh-title">secret</div><div className="cdsh-desc cdsh-mono">same-origin only</div></div>
          </div>
          <span className="cdsh-login-inline-input">
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
              required
              minLength={needsBootstrap ? 8 : undefined}
              className="cdsh-login-morph-input"
              placeholder={needsBootstrap ? 'password (8+ chars)' : 'password'}
            />
          </span>
        </label>

        <div className="cdsh-node cdsh-login-oauth-node" aria-hidden>
          <div className="cdsh-row">
            <span className="cdsh-ico"><Github /></span>
            <div><div className="cdsh-title">oauth</div><div className="cdsh-desc cdsh-mono">GitHub route</div></div>
          </div>
          <div className="cdsh-status"><span className="cdsh-sdot" />Optional handoff</div>
        </div>

        <div className={`cdsh-login-access-node${error ? ' cdsh-login-access-node-error' : ''}`}>
          <Terminal className="h-4 w-4" />
          <div className="min-w-0 flex-1">
            <div className="cdsh-lbl">{error ? 'Access · rejected' : busy ? (needsBootstrap ? 'Access · provisioning' : 'Access · verifying') : (needsBootstrap ? 'Access · first run' : 'Access · contracted')}</div>
            <div className="cdsh-url cdsh-mono truncate">{error || (needsBootstrap ? 'bootstrap / create-system-owner' : 'auth-flow / enter-system')}</div>
          </div>
          <Button type="submit" disabled={busy} className="cdsh-login-access-submit">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="cdsh-login-morph-actions">
        <Button asChild type="button" variant="outline" className="cdsh-login-side-action">
          <a href={githubLoginHref}>
            <Github className="mr-2 h-4 w-4" />
            GitHub
          </a>
        </Button>
        {props.onHome ? (
          <Button type="button" variant="outline" className="cdsh-login-side-action" onClick={props.onHome}>
            <Home className="mr-2 h-4 w-4" />
            Home
          </Button>
        ) : (
          <Button asChild type="button" variant="outline" className="cdsh-login-side-action">
            <Link to="/" viewTransition>
              <Home className="mr-2 h-4 w-4" />
              Home
            </Link>
          </Button>
        )}
      </div>

      <p className="cdsh-ticker cdsh-mono">
        <span className="cdsh-k">cds</span>&nbsp;&gt;&nbsp;
        <span>{busy ? 'authorize operator · session handoff' : 'await identity · secret · enter console'}</span>
      </p>
    </form>
  );
}

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  // 'checking' = 正在探会话态;'anon' = 未登录,展示登录框。已登录则直接跳走,
  // 不会停留在此状态。探测期间用加载态占位,避免先闪一下登录框再跳转。
  const [authPhase, setAuthPhase] = useState<'checking' | 'anon'>('checking');

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
    fetchSessionAuthed().then((ok) => {
      if (!alive) return;
      if (!ok) {
        setAuthPhase('anon');
        return;
      }
      const target = redirectTarget();
      if (/\.html(?:$|[?#])/i.test(target)) {
        // legacy server 路径:hard-load 让 Express 的 legacy→React 重定向生效。
        window.location.assign(target);
      } else {
        navigate(target, { replace: true, viewTransition: true });
      }
    });
    return () => {
      alive = false;
    };
  }, [navigate]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#120f17] text-[#f6f6f8]">
      <div className="cdsh-bg">
        <ShapeGrid
          className="cdsh-shapegrid"
          shape="hexagon"
          direction="diagonal"
          speed={0.49}
          squareSize={34}
          hoverTrailAmount={15}
          borderColor="rgba(255,255,255,0.09)"
          hoverFillColor="rgba(255,255,255,0.05)"
        />
        <div className="cdsh-vignette" />
      </div>

      <section className="relative z-10 flex min-h-screen items-center justify-center px-5 py-10">
        <div className="grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,1fr)_560px]">
          <div className="cdsh-rise hidden lg:block [text-shadow:0_2px_30px_rgba(0,0,0,0.72)]" style={{ animationDelay: '.05s' }}>
            <div className="inline-flex items-center gap-3 rounded-full border border-white/12 bg-white/[0.035] px-4 py-2 text-xs uppercase tracking-normal text-white/70 backdrop-blur-xl">
              <span className="h-1.5 w-1.5 rounded-full bg-[#dbe4ee] shadow-[0_0_14px_#dbe4ee]" />
              Operator gate
            </div>
            <h1 className="mt-8 max-w-xl text-balance text-[clamp(3.25rem,4.6vw,5.4rem)] font-[880] leading-[0.92] tracking-normal text-white">
              Enter the quiet
              <ShinyText
                text="control plane."
                speed={3.4}
                spread={112}
                color="rgba(226,226,235,0.62)"
                shineColor="rgba(255,255,255,0.98)"
                className="block cdsh-login-title-shine"
              />
            </h1>
            <p className="mt-6 max-w-lg text-base leading-8 text-white/70">
              A restrained access point for the systems that build, observe and recover cloud branch runtime.
            </p>
          </div>

          <div className="cdsh-login-panel cdsh-rise" style={{ animationDelay: '.18s' }}>
            {authPhase === 'checking' ? (
              <div className="flex min-h-[420px] items-center justify-center" role="status" aria-label="checking session">
                <Loader2 className="h-6 w-6 animate-spin text-white/70" />
              </div>
            ) : (
              <CdsAccessMorphBoard />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
