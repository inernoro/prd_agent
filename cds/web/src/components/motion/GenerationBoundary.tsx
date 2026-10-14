import { type ReactNode, useLayoutEffect, useRef, useEffect, useState } from 'react';
import { generate, type GenerationRun } from '@/lib/vendor/ui-generation/ui-generation';
import '@/lib/vendor/ui-generation/ui-generation.css';

const CARDS = '.cds-card-grid > article, .cds-branch-card-grid article';

/** Only cold loading uses construction: existing content and SSE updates never replay. */
export function GenerationBoundary({ loading, ready, children }: {
  loading: boolean; ready: boolean; children: ReactNode;
}): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(timer);
  }, [loading]);
  const root = useRef<HTMLDivElement>(null);
  const waited = useRef(false);
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const device = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    if (media.matches || (device.deviceMemory != null && device.deviceMemory <= 4)
      || (device.hardwareConcurrency > 0 && device.hardwareConcurrency <= 4) || device.connection?.saveData) {
      waited.current = false;
      return;
    }
    let runs: GenerationRun[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    let stopped = false;
    const cancel = () => {
      stopped = true;
      clearTimeout(timer);
      runs.forEach((run) => run.cancel());
      runs = [];
      observer?.disconnect();
    };
    const interrupt = () => { waited.current = false; cancel(); };
    const play = (pending: boolean) => {
      if (stopped || document.hidden) return;
      // Bound both DOM work and visual emphasis to two visible cards.
      const cards = [...host.querySelectorAll<HTMLElement>(CARDS)].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 120 && rect.bottom > 0 && rect.top < innerHeight;
      }).slice(0, 2);
      if (!cards.length) return;
      if (pending) waited.current = true;
      runs = cards.map((card) => generate(card, {
        mode: 'skeleton', duration: pending ? 900 : 400,
        ...(pending ? { holdAt: .68 } : { startAt: .74 }),
        maxParts: 18, keys: 2, onFallback: () => { waited.current = false; },
      }));
      // Overlay uses measured document coordinates: reveal immediately if they change.
      observer = new ResizeObserver((entries) => {
        if (entries.some((entry) => {
          const run = runs.find((item) => item.element === entry.target);
          const rect = run?.element.getBoundingClientRect();
          const old = sizes.get(entry.target);
          return rect && old && (Math.abs(rect.width - old.width) > 1 || Math.abs(rect.height - old.height) > 1);
        })) interrupt();
      });
      const sizes = new Map<Element, DOMRect>(cards.map((card) => [card, card.getBoundingClientRect()]));
      cards.forEach((card) => observer?.observe(card));
    };
    if (loading) {
      waited.current = false;
      // Fast cached responses stay instant. This delays decoration, never the request/content.
      timer = setTimeout(() => play(true), 120);
    } else {
      const shouldReveal = ready && waited.current;
      waited.current = false;
      if (shouldReveal) play(false);
    }
    const onVisibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener('scroll', interrupt, true);
    window.addEventListener('resize', interrupt);
    host.addEventListener('pointerdown', interrupt, true);
    host.addEventListener('focusin', interrupt, true);
    host.addEventListener('keydown', interrupt, true);
    media.addEventListener('change', interrupt);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancel();
      window.removeEventListener('scroll', interrupt, true);
      window.removeEventListener('resize', interrupt);
      host.removeEventListener('pointerdown', interrupt, true);
      host.removeEventListener('focusin', interrupt, true);
      host.removeEventListener('keydown', interrupt, true);
      media.removeEventListener('change', interrupt);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loading, ready]);
  return <div ref={root} data-generation-boundary>
    {children}
    {loading && slow ? <p role="status" className="mt-3 text-sm text-muted-foreground">
      正在等待服务器返回列表数据。
      <button type="button" className="ml-2 underline underline-offset-4" onClick={() => window.location.reload()}>重新加载</button>
    </p> : null}
  </div>;
}
