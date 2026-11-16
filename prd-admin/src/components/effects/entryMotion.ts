import { flushSync } from 'react-dom';
import { prefersReducedMotion } from '@/lib/themeApplier';

let preparation: Promise<unknown> | undefined;
/** Decode both plates and load the landing chunk before removing the login scene. */
export function prepareEntryScene() {
  return preparation ??= Promise.allSettled([
    import('@/pages/AgentLauncherPage'),
    ...['companion.webp', 'companion-sleep.webp'].map(file => {
      const image = new Image();
      image.src = `/media/entry/${file}`;
      return image.decode?.() ?? Promise.resolve();
    }),
  ]);
}

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void> };
};
/** One compositor crossfade covers the route commit, including the app shell. */
export function enterWorkspace(commit: () => void) {
  const doc = document as TransitionDocument;
  if (!doc.startViewTransition || prefersReducedMotion()) { commit(); return; }
  document.documentElement.classList.add('cinema-route-transition');
  const transition = doc.startViewTransition(async () => {
    flushSync(commit);
    // Allow the already-preloaded lazy route to commit before taking its snapshot.
    await Promise.resolve();
  });
  void transition.finished.catch(() => {}).finally(() => {
    document.documentElement.classList.remove('cinema-route-transition');
  });
}

/** Opt-in, local-only frame evidence; contains no account or request data. */
export function profileEntryMotion() {
  if (new URLSearchParams(window.location.search).get('motionProfile') !== '1') return;
  const intervals: number[] = [];
  const start = performance.now();
  let previous = start;
  const frame = (now: number) => {
    if (document.visibilityState !== 'visible') {
      document.documentElement.dataset.entryMotion = JSON.stringify({ invalid: 'background-tab' });
      return;
    }
    intervals.push(now - previous);
    previous = now;
    if (now - start < 8000) { requestAnimationFrame(frame); return; }
    const sorted = intervals.slice(1).sort((a, b) => a - b);
    document.documentElement.dataset.entryMotion = JSON.stringify({
      frames: sorted.length, medianMs: sorted[Math.floor(sorted.length * .5)],
      p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: Math.max(...sorted),
      over33Ms: sorted.filter(value => value > 33.4).length,
    });
  };
  requestAnimationFrame(frame);
}
