import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CdsGemLoader } from '@/components/brand/CdsGem';
import Hyperspeed from '@/components/effects/reactbits/Hyperspeed';
import { hyperspeedPresets } from '@/components/effects/reactbits/HyperspeedPresets';
import { cn } from '@/lib/utils';

type PreviewPreparingSurfaceProps = {
  branch?: string;
  status?: string;
  compact?: boolean;
};

export function PreviewPreparingSurface({
  branch = 'preview-handoff',
  status = '准备中',
  compact = false,
}: PreviewPreparingSurfaceProps): JSX.Element {
  const effectOptions = hyperspeedPresets.one;

  return (
    <div className="relative h-full min-h-[inherit] overflow-hidden bg-black text-white">
      <Hyperspeed effectOptions={effectOptions} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_520px_at_52%_50%,rgba(255,255,255,0.10),transparent_34%),linear-gradient(90deg,rgba(0,0,0,0.88),rgba(0,0,0,0.26)_50%,rgba(0,0,0,0.72))]" />
      <main
        className={cn(
          'relative z-10 grid h-full min-h-[inherit] items-center px-[clamp(32px,8vw,112px)] py-[clamp(30px,7vw,86px)]',
          compact ? 'max-w-[920px]' : 'max-w-[1120px]',
        )}
      >
        <section className="max-w-[760px] [text-shadow:0_2px_34px_rgba(0,0,0,0.72)]">
          <div className="mb-7 inline-flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.28em] text-white/68">
            {/* 构建上下文的加载器用琥珀矿色(状态系统:building = amber) */}
            <CdsGemLoader size="sm" mineral="amber" className="text-cyan-100" />
            CDS Preview Transit
          </div>
          <h1 className={cn('leading-[0.96] tracking-normal text-white/86', compact ? 'text-[clamp(38px,5vw,68px)]' : 'text-[clamp(54px,8vw,116px)]')}>
            预览环境准备中
          </h1>
          <p className="mt-7 max-w-[660px] text-[clamp(16px,1.55vw,22px)] leading-[1.78] text-white/72">
            CDS 正在打开新的预览窗口，并同步分支运行状态。
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <span className="rounded-full border border-white/18 bg-white/[0.055] px-4 py-2 font-mono text-xs text-white/82 backdrop-blur-md">{branch}</span>
            <span className="rounded-full border border-white/18 bg-white/[0.055] px-4 py-2 text-xs text-white/82 backdrop-blur-md">状态 · {status}</span>
          </div>
          <div className="mt-10 w-[min(660px,100%)] rounded-[18px] border border-white/16 bg-black/24 p-4 backdrop-blur-md">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-white/70">
              <span>预计处理进度</span>
              <strong className="font-mono text-[15px] text-white">68%</strong>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/12">
              <span className="block h-full w-[68%] rounded-full bg-[linear-gradient(90deg,#f8fafc,#03b3c3,#d856bf)] shadow-[0_0_18px_rgba(3,179,195,0.35)]" />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export function PreviewPreparingPage(): JSX.Element {
  const [params] = useSearchParams();
  const branch = useMemo(() => params.get('branch') || undefined, [params]);

  return (
    <main data-theme="dark" className="min-h-screen bg-black">
      <PreviewPreparingSurface branch={branch} />
    </main>
  );
}
