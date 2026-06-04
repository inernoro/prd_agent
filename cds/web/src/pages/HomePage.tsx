import { ArrowRight, Atom, Blocks, GitBranch, ShieldCheck, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { Button } from '@/components/ui/button';

const capabilities = [
  { icon: GitBranch, label: 'Branch Runtime', value: 'isolated preview environments' },
  { icon: Blocks, label: 'Container Control', value: 'build, start, observe, recover' },
  { icon: Terminal, label: 'Operational Trace', value: 'logs, metrics, webhooks, audit' },
];

export function HomePage(): JSX.Element {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#15121d] text-[#f7f5ff]">
      <ShapeGrid
        className="absolute inset-0 h-full w-full"
        direction="diagonal"
        speed={0.32}
        squareSize={34}
        shape="hexagon"
        borderColor="rgba(255,255,255,0.14)"
        hoverFillColor="rgba(255,255,255,0.05)"
        hoverTrailAmount={0}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(1100px_720px_at_50%_42%,rgba(255,255,255,0.11),transparent_46%),linear-gradient(180deg,rgba(21,18,29,0.42),rgba(15,12,21,0.72))]" />

      <section className="relative z-10 flex min-h-screen flex-col px-6 py-6 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between rounded-full border border-white/12 bg-white/[0.035] px-4 py-3 shadow-[0_24px_80px_rgba(0,0,0,0.4)] backdrop-blur-xl">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 shadow-[0_0_32px_rgba(255,255,255,0.1)]">
              <Atom className="h-6 w-6" />
            </span>
            <span className="text-sm font-semibold tracking-normal text-white/90">Cloud Dev Suite</span>
          </Link>
          <nav className="hidden items-center gap-2 text-sm text-white/60 md:flex">
            <Link className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" to="/project-list">Console</Link>
            <Link className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" to="/cds-settings">Settings</Link>
            <Link className="rounded-full px-3 py-2 hover:bg-white/10 hover:text-white" to="/login">Access</Link>
          </nav>
        </header>

        <div className="grid flex-1 items-center gap-10 py-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.64fr)]">
          <div className="max-w-4xl [text-shadow:0_2px_30px_rgba(0,0,0,0.72)]">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.035] px-3 py-1.5 text-xs font-medium uppercase tracking-normal text-white/70 backdrop-blur-xl">
              <span className="h-1.5 w-1.5 rounded-full bg-[#dbe4ee] shadow-[0_0_14px_#dbe4ee]" />
              Controlled cloud runtime
            </div>
            <h1 className="mt-8 max-w-5xl text-balance text-[clamp(4.5rem,10.5vw,9.8rem)] font-[880] leading-[0.88] tracking-normal text-white">
              Ship inside
              <span className="block bg-[linear-gradient(120deg,rgba(247,245,255,0.78)_0%,rgba(247,245,255,0.78)_38%,#fff_48%,rgba(255,255,255,0.96)_52%,rgba(247,245,255,0.78)_62%,rgba(247,245,255,0.78)_100%)] bg-[length:220%_100%] bg-clip-text text-transparent animate-[shiny-text_3.2s_linear_infinite]">
                the field.
              </span>
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-white/72">
              CDS turns branches into observable runtime space: every build, container, log, webhook and recovery path remains visible without breaking the control plane.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="rounded-full bg-white px-6 text-black hover:bg-white/90">
                <Link to="/login?redirect=%2Fproject-list">
                  Enter Console
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full border-white/15 bg-white/[0.035] px-6 text-white hover:bg-white/10 hover:text-white">
                <Link to="/login">System Access</Link>
              </Button>
            </div>
          </div>

          <aside className="rounded-[1.5rem] border border-white/12 bg-white/[0.035] p-5 shadow-[0_30px_120px_rgba(0,0,0,0.4)] backdrop-blur-xl">
            <div className="rounded-[1.15rem] border border-white/12 bg-white/[0.025] p-5">
              <div className="flex items-center justify-between border-b border-white/10 pb-5">
                <div>
                  <div className="font-mono text-xs uppercase tracking-normal text-white/50">Runtime field</div>
                  <div className="mt-1 text-2xl font-semibold">Control Plane</div>
                </div>
                <ShieldCheck className="h-7 w-7 text-[#dbe4ee]" />
              </div>
              <div className="mt-5 space-y-3">
                {capabilities.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="rounded-xl border border-white/12 bg-white/[0.025] p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/12 bg-white/[0.04]">
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
              <div className="mt-5 rounded-xl border border-white/12 bg-white/[0.04] p-4 font-mono text-xs leading-6 text-white/80">
                cds.live.sync / branch.ready / container.observed / operator.safe
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
