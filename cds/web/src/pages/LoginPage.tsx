import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Github, Home, KeyRound, Loader2, LockKeyhole, Server, Shield, UserRound } from 'lucide-react';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { CdsMetallicLogo } from '@/components/brand/CdsMetallicLogo';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/api';
import './HomePage.css';

function redirectTarget(): string {
  if (typeof window === 'undefined') return '/project-list';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('redirect') || '/project-list';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/project-list';
  return raw;
}

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const target = useMemo(() => redirectTarget(), []);
  const githubLoginHref = useMemo(() => apiUrl(`/api/auth/github/login?redirect=${encodeURIComponent(target)}`), [target]);

  // 登录成功后要跳的内容页(默认控制台)是 lazy chunk:登录页一挂载就预取,
  // 提交成功 navigate 时不会触发 Suspense 白屏,配合 viewTransition 丝滑进内容页。
  useEffect(() => {
    void import('@/pages/ProjectListPage');
    void import('@/pages/HomePage');
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
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
      if (/\.html(?:$|[?#])/i.test(target)) {
        window.location.assign(target);
      } else {
        navigate(target, { replace: true, viewTransition: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
        <div className="grid w-full max-w-5xl items-center gap-10 lg:grid-cols-[minmax(0,1fr)_440px]">
          <div className="cdsh-rise hidden lg:block [text-shadow:0_2px_30px_rgba(0,0,0,0.72)]" style={{ animationDelay: '.05s' }}>
            <div className="inline-flex items-center gap-3 rounded-full border border-white/12 bg-white/[0.035] px-4 py-2 text-xs uppercase tracking-normal text-white/70 backdrop-blur-xl">
              <span className="h-1.5 w-1.5 rounded-full bg-[#dbe4ee] shadow-[0_0_14px_#dbe4ee]" />
              Operator gate
            </div>
            <h1 className="mt-8 max-w-xl text-balance text-[clamp(3.8rem,6vw,5.9rem)] font-[880] leading-[0.92] tracking-normal text-white">
              Enter the quiet
              <span className="block bg-[linear-gradient(120deg,rgba(247,245,255,0.78)_0%,rgba(247,245,255,0.78)_38%,#fff_48%,rgba(255,255,255,0.96)_52%,rgba(247,245,255,0.78)_62%,rgba(247,245,255,0.78)_100%)] bg-[length:220%_100%] bg-clip-text text-transparent animate-[shiny-text_3.2s_linear_infinite]">
                control plane.
              </span>
            </h1>
            <p className="mt-6 max-w-lg text-base leading-8 text-white/70">
              A restrained access point for the systems that build, observe and recover cloud branch runtime.
            </p>
          </div>

          <div className="cdsh-login-panel cdsh-rise" style={{ animationDelay: '.18s' }}>
            <form onSubmit={submit} className="cdsh-login-console">
              <div className="cdsh-login-head">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="cdsh-login-logo">
                    <CdsMetallicLogo className="h-6 w-6" />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[17px] font-semibold leading-tight">Cloud Dev Suite</div>
                    <div className="mt-1 font-mono text-[10.5px] uppercase tracking-normal text-white/48">control access</div>
                  </div>
                </div>
                <span className="cdsh-login-live">
                  <span className="cdsh-pulse" />
                  secure
                </span>
              </div>

              <div className="cdsh-access-map" aria-hidden>
                <div className="cdsh-access-node">
                  <UserRound />
                  <span>Identity</span>
                </div>
                <span className="cdsh-access-link" />
                <div className="cdsh-access-node">
                  <Shield />
                  <span>Session</span>
                </div>
                <span className="cdsh-access-link" />
                <div className="cdsh-access-node">
                  <Server />
                  <span>Console</span>
                </div>
              </div>

              <div className="mt-5 space-y-3">
                <label className="cdsh-login-field">
                  <span className="cdsh-login-label">Identity</span>
                  <span className="cdsh-login-inputwrap">
                    <UserRound className="cdsh-login-input-icon" aria-hidden />
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      autoFocus
                      required
                      className="cdsh-login-input"
                      placeholder="operator"
                    />
                  </span>
                </label>
                <label className="cdsh-login-field">
                  <span className="cdsh-login-label">Secret</span>
                  <span className="cdsh-login-inputwrap">
                    <KeyRound className="cdsh-login-input-icon" aria-hidden />
                    <input
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      type="password"
                      autoComplete="current-password"
                      required
                      className="cdsh-login-input"
                      placeholder="password"
                    />
                  </span>
                </label>
              </div>

              {error ? (
                <div className="mt-3 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3.5 py-2.5 text-sm text-rose-100/80">
                  {error}
                </div>
              ) : null}

              <Button type="submit" disabled={busy} className="mt-4 h-12 w-full rounded-xl bg-white text-[15px] font-semibold text-black shadow-[0_16px_46px_rgba(255,255,255,0.12)] hover:bg-white/90">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}
                Enter System
                {!busy ? <ArrowRight className="ml-2 h-4 w-4" /> : null}
              </Button>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <Button asChild type="button" variant="outline" className="h-11 rounded-xl border-white/12 bg-white/[0.035] text-white hover:bg-white/10 hover:text-white">
                  <a href={githubLoginHref}>
                    <Github className="mr-2 h-4 w-4" />
                    GitHub
                  </a>
                </Button>
                <Button asChild type="button" variant="outline" className="h-11 rounded-xl border-white/12 bg-white/[0.035] text-white hover:bg-white/10 hover:text-white">
                  <Link to="/" viewTransition>
                    <Home className="mr-2 h-4 w-4" />
                    Home
                  </Link>
                </Button>
              </div>

              <div className="cdsh-login-foot">
                <span className="cdsh-mono">access.session</span>
                <span>same-origin cookie</span>
                <span>no local secret persistence</span>
              </div>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
