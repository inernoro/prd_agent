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
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(56.25rem_32.5rem_at_52%_50%,rgba(255,255,255,0.10),transparent_34%),linear-gradient(90deg,rgba(0,0,0,0.88),rgba(0,0,0,0.26)_50%,rgba(0,0,0,0.72))]" />
      <main
        className={cn(
          'relative z-10 grid h-full min-h-[inherit] items-center px-[clamp(2rem,8vw,7rem)] py-[clamp(1.875rem,7vw,5.375rem)]',
          compact ? 'max-w-[57.5rem]' : 'max-w-[70rem]',
        )}
      >
        <section className="max-w-[55rem] [text-shadow:0_2px_2.125rem_rgba(0,0,0,0.72)]">
          <div role="status" aria-live="polite" className="mb-7 inline-flex max-w-full flex-wrap items-center gap-2.5 text-sm text-white/82">
            {/* 构建上下文的加载器用琥珀矿色(状态系统:building = amber) */}
            <CdsGemLoader size="sm" mineral="amber" className="text-cyan-100" />
            <span className="min-w-0 break-all font-mono">{branch}</span>
            <span className="min-w-0 max-w-full break-all">· {status}</span>
          </div>
          <h1 className={cn('leading-[0.96] tracking-normal text-white/86', compact ? 'text-[clamp(2.375rem,5vw,4.25rem)]' : 'text-[clamp(3.375rem,8vw,7.25rem)]')}>
            预览环境准备中
          </h1>
          <p className="mt-7 max-w-[41.25rem] text-[clamp(1rem,1.55vw,1.375rem)] leading-[1.78] text-white/72">
            CDS 正在打开新的预览窗口，并同步分支运行状态。
          </p>
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
