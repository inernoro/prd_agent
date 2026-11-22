import { planningToday } from './engineering-planning-domain.js';

const DAY = 86_400_000;
const RETRY = 5 * 60_000;

function lastSweepCutoff(now: Date) {
  const today = Date.parse(`${planningToday(now)}T06:00:00+08:00`);
  return today <= now.getTime() ? today : today - DAY;
}

/** Process the latest Shanghai cutoff on startup, then run once at each daily cutoff. */
export function startPlanningSweep({ projects, sweep, onError, now = () => new Date() }: {
  projects: () => Iterable<string>;
  sweep: (project: string, through: Date, signal: AbortSignal) => Promise<void>;
  onError: () => void;
  now?: () => Date;
}) {
  const shutdown = new AbortController();
  const { signal } = shutdown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  let currentCutoff = 0;
  const finished = new Set<string>();

  function tick() {
    const cutoff = lastSweepCutoff(now());
    if (cutoff !== currentCutoff) {
      currentCutoff = cutoff;
      finished.clear();
    }
    let failed = false;
    const retry = () => { failed = true; onError(); };
    running = Promise.resolve().then(async () => {
      const through = new Date(cutoff);
      for (const project of projects()) {
        if (signal.aborted) break;
        if (finished.has(project)) continue;
        try {
          await sweep(project, through, signal);
          finished.add(project);
        } catch {
          retry();
        }
      }
    }).catch(retry).finally(() => {
      if (signal.aborted) return;
      const time = now().getTime();
      const next = failed ? Math.min(cutoff + DAY, time + RETRY) : cutoff + DAY;
      timer = setTimeout(tick, Math.max(0, next - time));
      timer.unref();
    });
  }

  tick();
  return async () => {
    shutdown.abort();
    clearTimeout(timer);
    await running;
  };
}
