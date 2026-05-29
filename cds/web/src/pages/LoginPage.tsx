import { useMemo, useState } from 'react';
import { ArrowRight, Github, Loader2, LockKeyhole, Shield } from 'lucide-react';
import { CdsFloatingBackdrop } from '@/components/brand/CdsFloatingBackdrop';
import { CdsMetallicLogo } from '@/components/brand/CdsMetallicLogo';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/api';

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
  const githubLoginHref = useMemo(() => apiUrl(`/api/auth/github/login?redirect=${encodeURIComponent(target)}`), [target]);

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
      window.location.href = target;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#211729] text-white">
      <CdsFloatingBackdrop />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(18,11,23,0.50),rgba(18,11,23,0.16)_48%,rgba(18,11,23,0.06)),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(24,15,30,0.12)_72%,rgba(16,10,22,0.48))]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_580px_at_54%_44%,rgba(233,71,245,0.12),transparent_66%),radial-gradient(780px_520px_at_74%_52%,rgba(255,255,255,0.055),transparent_70%)]" />

      <section className="relative z-10 flex min-h-screen items-center justify-center px-5 py-10">
        <div className="grid w-full max-w-5xl items-center gap-10 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="hidden lg:block">
            <div className="inline-flex items-center gap-3 rounded-full border border-white/20 bg-black/25 px-4 py-2 text-xs uppercase tracking-normal text-white/70 backdrop-blur-xl">
              <span className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_18px_rgba(255,255,255,0.8)]" />
              Operator gate
            </div>
            <h1 className="mt-8 max-w-xl text-balance text-[clamp(3.8rem,6vw,5.9rem)] font-[880] leading-[0.92] tracking-normal [text-shadow:0_18px_80px_rgba(0,0,0,0.42)]">
              Enter the quiet
              <span className="block bg-[linear-gradient(100deg,#fff_0%,#f8eaff_42%,#ff6df1_58%,#fff_82%)] bg-clip-text text-transparent">
                control plane.
              </span>
            </h1>
            <p className="mt-6 max-w-lg text-base leading-8 text-white/70">
              A restrained access point for the systems that build, observe and recover cloud branch runtime.
            </p>
          </div>

          <div className="rounded-[1.5rem] border border-white/20 bg-[rgba(58,40,68,0.56)] p-2 shadow-[0_32px_120px_rgba(0,0,0,0.46)] backdrop-blur-xl">
            <form onSubmit={submit} className="rounded-[1.15rem] border border-white/20 bg-white/[0.05] p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/20 bg-black/25">
                    <CdsMetallicLogo className="h-8 w-8" />
                  </span>
                  <div>
                    <div className="text-lg font-semibold">Cloud Dev Suite</div>
                    <div className="mt-0.5 font-mono text-[11px] uppercase tracking-normal text-white/50">secure access</div>
                  </div>
                </div>
                <Shield className="h-5 w-5 text-fuchsia-100/70" />
              </div>

              <div className="mt-8 space-y-4">
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-normal text-white/50">Identity</span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                    className="h-12 w-full rounded-lg border border-white/20 bg-black/25 px-4 text-sm text-white outline-none transition-colors placeholder:text-white/35 focus:border-fuchsia-100/50 focus:bg-black/30 focus:ring-2 focus:ring-fuchsia-200/20"
                    placeholder="operator"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-normal text-white/50">Secret</span>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    autoComplete="current-password"
                    required
                    className="h-12 w-full rounded-lg border border-white/20 bg-black/25 px-4 text-sm text-white outline-none transition-colors placeholder:text-white/35 focus:border-fuchsia-100/50 focus:bg-black/30 focus:ring-2 focus:ring-fuchsia-200/20"
                    placeholder="password"
                  />
                </label>
              </div>

              {error ? (
                <div className="mt-4 rounded-xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100/80">
                  {error}
                </div>
              ) : null}

              <Button type="submit" disabled={busy} className="mt-6 h-12 w-full rounded-lg bg-white text-black hover:bg-white/90">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}
                Enter System
                {!busy ? <ArrowRight className="ml-2 h-4 w-4" /> : null}
              </Button>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <Button asChild type="button" variant="outline" className="rounded-lg border-white/20 bg-black/20 text-white hover:bg-white/10 hover:text-white">
                  <a href={githubLoginHref}>
                    <Github className="mr-2 h-4 w-4" />
                    GitHub
                  </a>
                </Button>
                <Button asChild type="button" variant="outline" className="rounded-lg border-white/20 bg-black/20 text-white hover:bg-white/10 hover:text-white">
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
