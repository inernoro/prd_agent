import { ArrowRight, Atom, Blocks, GitBranch, ShieldCheck, Terminal } from 'lucide-react';
import FloatingLines from '@/components/effects/reactbits/FloatingLines';
import { Button } from '@/components/ui/button';

const capabilities = [
  { icon: GitBranch, label: 'Branch Runtime', value: 'isolated preview environments' },
  { icon: Blocks, label: 'Container Control', value: 'build, start, observe, recover' },
  { icon: Terminal, label: 'Operational Trace', value: 'logs, metrics, webhooks, audit' },
];

export function HomePage(): JSX.Element {
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
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(18,15,23,0.88),rgba(18,15,23,0.48)_45%,rgba(18,15,23,0.08)),linear-gradient(180deg,rgba(18,15,23,0.05),rgba(18,15,23,0.52)_82%,#120F17)]" />

      <section className="relative z-10 flex min-h-screen flex-col px-6 py-6 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between rounded-full border border-white/10 bg-white/[0.045] px-4 py-3 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-2xl">
          <a href="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 shadow-[0_0_32px_rgba(255,255,255,0.12)]">
              <Atom className="h-6 w-6" />
            </span>
            <span className="text-sm font-semibold tracking-[0.24em] text-white/86">CLOUD DEV SUITE</span>
          </a>
          <nav className="hidden items-center gap-2 text-sm text-white/62 md:flex">
            <a className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" href="/project-list">Console</a>
            <a className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" href="/cds-settings">Settings</a>
            <a className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" href="/login">Access</a>
          </nav>
        </header>

        <div className="grid flex-1 items-center gap-10 py-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.64fr)]">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.055] px-3 py-1.5 text-xs font-medium uppercase tracking-[0.24em] text-white/68 backdrop-blur-xl">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.9)]" />
              Controlled cloud runtime
            </div>
            <h1 className="mt-8 max-w-5xl text-balance text-6xl font-black leading-[0.86] tracking-normal md:text-8xl lg:text-9xl">
              Ship inside the field.
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-white/68">
              CDS turns branches into observable runtime space: every build, container, log, webhook and recovery path remains visible without breaking the control plane.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="rounded-full bg-white px-6 text-black hover:bg-white/86">
                <a href="/project-list">
                  Enter Console
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full border-white/16 bg-white/[0.045] px-6 text-white hover:bg-white/10 hover:text-white">
                <a href="/login">System Access</a>
              </Button>
            </div>
          </div>

          <aside className="rounded-[2rem] border border-white/14 bg-white/[0.065] p-5 shadow-[0_30px_120px_rgba(0,0,0,0.36)] backdrop-blur-3xl">
            <div className="rounded-[1.5rem] border border-white/10 bg-black/24 p-5">
              <div className="flex items-center justify-between border-b border-white/10 pb-5">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] text-white/45">Runtime field</div>
                  <div className="mt-1 text-2xl font-semibold">Control Plane</div>
                </div>
                <ShieldCheck className="h-7 w-7 text-emerald-300" />
              </div>
              <div className="mt-5 space-y-3">
                {capabilities.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06]">
                          <Icon className="h-5 w-5 text-white/82" />
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-white/90">{item.label}</div>
                          <div className="mt-1 text-sm leading-6 text-white/48">{item.value}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-5 rounded-2xl border border-emerald-300/16 bg-emerald-300/[0.06] p-4 font-mono text-xs leading-6 text-emerald-100/72">
                cds.live.sync / branch.ready / container.observed / operator.safe
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
