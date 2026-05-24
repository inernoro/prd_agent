import { useMemo, useState } from 'react';
import { ArrowRight, Github, Loader2, LockKeyhole, Shield } from 'lucide-react';
import FloatingLines from '@/components/effects/reactbits/FloatingLines';
import { CdsMetallicLogo } from '@/components/brand/CdsMetallicLogo';
import { Button } from '@/components/ui/button';

function redirectTarget(): string {
  if (typeof window === 'undefined') return '/project-list';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('redirect') || '/project-list';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/project-list';
  return raw;
}

export function LoginPage(): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const target = useMemo(() => redirectTarget(), []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
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
      window.location.href = target;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#120F17] text-white">
      <div className="absolute inset-0">
        <FloatingLines
          linesGradient={['#5227FF', '#FF9FFC', '#B19EEF']}
          enabledWaves={['top', 'middle', 'bottom']}
          lineCount={[10, 16, 20]}
          lineDistance={[8, 6, 4]}
          topWavePosition={{ x: 10, y: 0.5, rotate: -0.4 }}
          middleWavePosition={{ x: 5, y: 0, rotate: 0.2 }}
          bottomWavePosition={{ x: 2, y: -0.7, rotate: 0.4 }}
          interactive
          parallax
          parallaxStrength={0.18}
          animationSpeed={1}
          bendRadius={5}
          bendStrength={-0.5}
          mouseDamping={0.05}
          mixBlendMode="screen"
        />
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(18,15,23,0.9),rgba(18,15,23,0.52)_45%,rgba(18,15,23,0.12)),linear-gradient(180deg,rgba(18,15,23,0.05),rgba(18,15,23,0.62)_82%,#120F17)]" />

      <section className="relative z-10 flex min-h-screen items-center justify-center px-5 py-10">
        <div className="grid w-full max-w-5xl items-center gap-10 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="hidden lg:block">
            <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.045] px-4 py-2 text-xs uppercase tracking-[0.26em] text-white/56 backdrop-blur-xl">
              <span className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_18px_rgba(255,255,255,0.8)]" />
              Operator gate
            </div>
            <h1 className="mt-8 max-w-xl text-balance text-6xl font-black leading-[0.9] tracking-normal">
              Enter the quiet control plane.
            </h1>
            <p className="mt-6 max-w-lg text-base leading-8 text-white/58">
              A restrained access point for the systems that build, observe and recover cloud branch runtime.
            </p>
          </div>

          <div className="rounded-[2rem] border border-white/14 bg-white/[0.075] p-2 shadow-[0_32px_120px_rgba(0,0,0,0.52)] backdrop-blur-3xl">
            <form onSubmit={submit} className="rounded-[1.6rem] border border-white/10 bg-black/28 p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/12 bg-white/[0.06]">
                    <CdsMetallicLogo className="h-8 w-8" />
                  </span>
                  <div>
                    <div className="text-lg font-semibold">Cloud Dev Suite</div>
                    <div className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/42">secure access</div>
                  </div>
                </div>
                <Shield className="h-5 w-5 text-white/42" />
              </div>

              <div className="mt-8 space-y-4">
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-white/44">Identity</span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                    className="h-12 w-full rounded-xl border border-white/10 bg-white/[0.055] px-4 text-sm text-white outline-none transition focus:border-white/28 focus:bg-white/[0.075]"
                    placeholder="operator"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-white/44">Secret</span>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    autoComplete="current-password"
                    required
                    className="h-12 w-full rounded-xl border border-white/10 bg-white/[0.055] px-4 text-sm text-white outline-none transition focus:border-white/28 focus:bg-white/[0.075]"
                    placeholder="password"
                  />
                </label>
              </div>

              {error ? (
                <div className="mt-4 rounded-xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100/82">
                  {error}
                </div>
              ) : null}

              <Button type="submit" disabled={busy} className="mt-6 h-12 w-full rounded-xl bg-white text-black hover:bg-white/88">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}
                Enter System
                {!busy ? <ArrowRight className="ml-2 h-4 w-4" /> : null}
              </Button>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <Button asChild type="button" variant="outline" className="rounded-xl border-white/12 bg-white/[0.035] text-white hover:bg-white/10 hover:text-white">
                  <a href="/login-gh.html">
                    <Github className="mr-2 h-4 w-4" />
                    GitHub
                  </a>
                </Button>
                <Button asChild type="button" variant="outline" className="rounded-xl border-white/12 bg-white/[0.035] text-white hover:bg-white/10 hover:text-white">
                  <a href="/">Home</a>
                </Button>
              </div>

              <div className="mt-6 border-t border-white/10 pt-5 font-mono text-[11px] leading-5 text-white/38">
                access.session / same-origin cookie / no local secret persistence
              </div>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
