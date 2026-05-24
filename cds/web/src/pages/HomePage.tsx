import { ArrowRight, Atom, Blocks, GitBranch, ShieldCheck, Terminal } from 'lucide-react';
import { CdsFloatingBackdrop } from '@/components/brand/CdsFloatingBackdrop';
import { Button } from '@/components/ui/button';

const capabilities = [
  { icon: GitBranch, label: 'Branch Runtime', value: 'isolated preview environments' },
  { icon: Blocks, label: 'Container Control', value: 'build, start, observe, recover' },
  { icon: Terminal, label: 'Operational Trace', value: 'logs, metrics, webhooks, audit' },
];

export function HomePage(): JSX.Element {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#211729] text-white">
      <CdsFloatingBackdrop />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(18,11,23,0.34),rgba(18,11,23,0.10)_46%,rgba(18,11,23,0.04)),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(24,15,30,0.10)_70%,rgba(16,10,22,0.42))]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(1100px_680px_at_50%_45%,rgba(233,71,245,0.12),transparent_64%),radial-gradient(900px_560px_at_70%_58%,rgba(255,255,255,0.06),transparent_70%)]" />

      <section className="relative z-10 flex min-h-screen flex-col px-6 py-6 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between rounded-full border border-white/20 bg-[rgba(59,41,70,0.54)] px-4 py-3 shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <a href="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 shadow-[0_0_32px_rgba(255,255,255,0.12)]">
              <Atom className="h-6 w-6" />
            </span>
            <span className="text-sm font-semibold tracking-normal text-white/90">Cloud Dev Suite</span>
          </a>
          <nav className="hidden items-center gap-2 text-sm text-white/60 md:flex">
            <a className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" href="/project-list">Console</a>
            <a className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" href="/cds-settings">Settings</a>
            <a className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" href="/login">Access</a>
          </nav>
        </header>

        <div className="grid flex-1 items-center gap-10 py-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.64fr)]">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/25 px-3 py-1.5 text-xs font-medium uppercase tracking-normal text-white/70 backdrop-blur-xl">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.9)]" />
              Controlled cloud runtime
            </div>
            <h1 className="mt-8 max-w-5xl text-balance text-[clamp(4.5rem,10.5vw,9.8rem)] font-[880] leading-[0.88] tracking-normal text-white [text-shadow:0_18px_80px_rgba(0,0,0,0.44)]">
              Ship inside
              <span className="block bg-[linear-gradient(100deg,#fff_0%,#f8eaff_42%,#ff6df1_58%,#fff_82%)] bg-clip-text text-transparent">
                the field.
              </span>
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-white/75">
              CDS turns branches into observable runtime space: every build, container, log, webhook and recovery path remains visible without breaking the control plane.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="rounded-full bg-white px-6 text-black hover:bg-white/90">
                <a href="/project-list">
                  Enter Console
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full border-white/20 bg-white/[0.045] px-6 text-white hover:bg-white/10 hover:text-white">
                <a href="/login">System Access</a>
              </Button>
            </div>
          </div>

          <aside className="rounded-[1.5rem] border border-white/20 bg-[rgba(58,40,68,0.54)] p-5 shadow-[0_30px_120px_rgba(0,0,0,0.34)] backdrop-blur-xl">
            <div className="rounded-[1.15rem] border border-white/20 bg-white/[0.05] p-5">
              <div className="flex items-center justify-between border-b border-white/10 pb-5">
                <div>
                  <div className="font-mono text-xs uppercase tracking-normal text-white/50">Runtime field</div>
                  <div className="mt-1 text-2xl font-semibold">Control Plane</div>
                </div>
                <ShieldCheck className="h-7 w-7 text-emerald-300" />
              </div>
              <div className="mt-5 space-y-3">
                {capabilities.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="rounded-xl border border-white/20 bg-white/[0.045] p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/[0.065]">
                          <Icon className="h-5 w-5 text-white/80" />
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-white/90">{item.label}</div>
                          <div className="mt-1 text-sm leading-6 text-white/50">{item.value}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-5 rounded-xl border border-white/20 bg-white/[0.075] p-4 font-mono text-xs leading-6 text-white/80">
                cds.live.sync / branch.ready / container.observed / operator.safe
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
