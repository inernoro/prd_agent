import { type ReactNode, useLayoutEffect, useRef, useEffect, useState } from 'react';
import { generate, type GenerationRun } from '@/lib/vendor/ui-generation/ui-generation';
import '@/lib/vendor/ui-generation/ui-generation.css';

const CARDS = '.cds-card-grid > article, .cds-branch-card-grid article';
const PENDING = '[aria-busy="true"] .cds-card-grid > article, [aria-busy="true"] .cds-branch-card-grid article';
const visible = (card: HTMLElement) => {
  const rect = card.getBoundingClientRect();
  return rect.width > 120 && rect.bottom > 0 && rect.top < innerHeight;
};
// A short overlapping wave, never a queue of complete animations.
const stagger = (index: number, count: number) => index * Math.min(80, 320 / Math.max(1, count - 1));
const motion = { mode: 'skeleton' as const, duration: 1400, holdAt: .68, revealDuration: 640, maxParts: 18, keys: 1 };

/** One lifetime spans route-chunk loading, data loading and the native scan reveal. */
export function GenerationBoundary({ enabled, children }: { enabled: boolean; children: ReactNode }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [waiting, setWaiting] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(timer);
  }, [waiting]);

  useLayoutEffect(() => {
    const host = root.current;
    if (!host || !enabled) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const device = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const supported = () => !media.matches && !(device.deviceMemory != null && device.deviceMemory <= 4)
      && !(device.hardwareConcurrency > 0 && device.hardwareConcurrency <= 4) && !device.connection?.saveData;
    let pending = false;
    let interrupted = false;
    let previous: HTMLElement[] = [];
    let runs: Array<{ index: number; run: GenerationRun }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sizes = new Map<Element, { width: number; height: number; left: number; top: number }>();
    const cancelRuns = () => {
      clearTimeout(timer); timer = undefined;
      runs.forEach(({ run }) => run.cancel()); runs = [];
      resize.disconnect(); sizes.clear();
    };
    const interrupt = () => { interrupted = true; cancelRuns(); };
    const resize = new ResizeObserver((entries) => {
      if (entries.some(({ target }) => {
        const old = sizes.get(target), rect = target.getBoundingClientRect();
        return old && (Math.abs(old.width - rect.width) > 1 || Math.abs(old.height - rect.height) > 1);
      })) interrupt();
    });
    const observeSizes = () => {
      resize.disconnect(); sizes = new Map();
      for (const { run } of runs) {
        const rect = run.element.getBoundingClientRect();
        sizes.set(run.element, { width: rect.width, height: rect.height, left: rect.left, top: rect.top });
        resize.observe(run.element);
      }
    };
    const play = () => {
      timer = undefined;
      if (!pending || interrupted || !supported() || document.hidden) return;
      const cards = [...host.querySelectorAll<HTMLElement>(PENDING)];
      const visibleCount = cards.filter(visible).length;
      let order = 0;
      runs = cards.flatMap((card, index) => {
        if (!visible(card)) return [];
        return [{ index, run: generate(card, {
          ...motion, delay: stagger(order++, visibleCount), onFallback: interrupt,
        }) }];
      });
      observeSizes();
    };
    const synchronize = () => {
      const cards = [...host.querySelectorAll<HTMLElement>(PENDING)];
      if (cards.length) {
        if (!pending) {
          cancelRuns(); pending = true; interrupted = false;
          setWaiting(true);
          timer = setTimeout(play, 120); // Cached/fast content never waits for decoration.
        } else if (runs.length && cards.some((card, index) => card !== previous[index])) {
          // Chunk fallback -> page skeleton: retain the same overlay and construction clock.
          runs = runs.filter(({ index, run }) => {
            if (cards[index] && run.handoff(cards[index])) return true;
            run.cancel(); return false;
          });
          observeSizes();
        }
        previous = cards;
        return;
      }
      if (!pending) {
        // A real card deleted/reordered during the scan must not leave an overlay at its old position.
        if (runs.some(({ run }) => {
          const old = sizes.get(run.element), rect = run.element.getBoundingClientRect();
          return !run.element.isConnected || (old && (Math.abs(old.left - rect.left) > 4 || Math.abs(old.top - rect.top) > 4));
        })) interrupt();
        return; // Refresh/SSE mutations never replay already-loaded content.
      }
      pending = false; previous = []; setWaiting(false);
      clearTimeout(timer); timer = undefined;
      const ready = [...host.querySelectorAll<HTMLElement>(CARDS)];
      const waitingRuns = new Map(runs.map(({ index, run }) => [index, run]));
      const reveal = runs.length > 0 && !interrupted && supported();
      const visibleCount = ready.filter(visible).length;
      let order = 0;
      runs = reveal ? ready.flatMap((card, index) => {
        if (!visible(card)) return [];
        const revealDelay = stagger(order++, visibleCount);
        const run = waitingRuns.get(index);
        if (run?.handoff(card, { reveal: true, revealDelay })) {
          waitingRuns.delete(index);
          return [{ index, run }];
        }
        // Group headers/counts can move cards or introduce more than six real cards.
        // Measure their final DOM too; never leave the trailing cards as a plain swap.
        return [{ index, run: generate(card, { ...motion, revealOnly: true, revealDelay, onFallback: interrupt }) }];
      }) : [];
      waitingRuns.forEach((run) => run.cancel());
      observeSizes();
      const revealing = runs;
      void Promise.all(revealing.map(({ run }) => run.finished)).then(() => {
        if (runs === revealing) { runs = []; resize.disconnect(); sizes.clear(); }
      });
    };
    const mutation = new MutationObserver(synchronize);
    mutation.observe(host, { childList: true, subtree: true });
    synchronize();
    const visibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener('scroll', interrupt, true);
    window.addEventListener('resize', interrupt);
    host.addEventListener('pointerdown', interrupt, true);
    host.addEventListener('focusin', interrupt, true);
    host.addEventListener('keydown', interrupt, true);
    media.addEventListener('change', interrupt);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mutation.disconnect(); cancelRuns();
      window.removeEventListener('scroll', interrupt, true);
      window.removeEventListener('resize', interrupt);
      host.removeEventListener('pointerdown', interrupt, true);
      host.removeEventListener('focusin', interrupt, true);
      host.removeEventListener('keydown', interrupt, true);
      media.removeEventListener('change', interrupt);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled]);

  return <div ref={root} className="contents" data-generation-boundary>
    {children}
    {waiting && slow ? <p role="status" className="col-span-full px-6 pb-4 text-sm text-muted-foreground">
      正在等待服务器返回列表数据。
      <button type="button" className="ml-2 underline underline-offset-4" onClick={() => window.location.reload()}>重新加载</button>
    </p> : null}
  </div>;
}
