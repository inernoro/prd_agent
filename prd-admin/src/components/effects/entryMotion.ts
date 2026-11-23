import { PORTRAIT_ASSETS } from './portraitMotionAsset';

let preparation: Promise<unknown> | undefined;
/** Decode the landing portrait and load the landing chunk before removing the login scene. */
export function prepareEntryScene() {
  if (!preparation) {
    const poster = new Image();
    poster.src = PORTRAIT_ASSETS.open;
    preparation = Promise.allSettled([import('@/pages/AgentLauncherPage'), poster.decode()]);
  }
  return preparation;
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
    if (now - start < 12000) { requestAnimationFrame(frame); return; }
    const sorted = intervals.slice(1).sort((a, b) => a - b);
    document.documentElement.dataset.entryMotion = JSON.stringify({
      frames: sorted.length, medianMs: sorted[Math.floor(sorted.length * .5)],
      p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: Math.max(...sorted),
      over33Ms: sorted.filter(value => value > 33.4).length,
    });
  };
  requestAnimationFrame(frame);
}
