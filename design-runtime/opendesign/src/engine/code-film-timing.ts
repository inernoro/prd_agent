import fs from 'node:fs';

type Work = 'render' | 'speech';

function activeFilmWork(daemonPid: number): Set<Work> {
  const processes = new Map<number, {parent: number; command: string}>();
  for (const entry of fs.readdirSync('/proc', {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry.name}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const [, parent] = stat.slice(close + 2).split(' ');
      processes.set(Number(entry.name), {parent: Number(parent), command: stat.slice(stat.indexOf('(') + 1, close)});
    } catch {
      // Short-lived processes can exit between listing procfs and reading stat.
    }
  }
  const children = new Map<number, number[]>();
  for (const [pid, proc] of processes) {
    const siblings = children.get(proc.parent) ?? [];
    siblings.push(pid);
    children.set(proc.parent, siblings);
  }
  const active = new Set<Work>();
  const pending = [...children.get(daemonPid) ?? []];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    const command = processes.get(pid)!.command;
    pending.push(...children.get(pid) ?? []);
    if (/^(chrome|chromium)/.test(command)) {
      active.add('render');
    } else if (/^(ffmpeg|python|edge-tts|node)/.test(command)) {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if ((command === 'ffmpeg' && args.some(arg => /\.(mp4|webm|mkv)$/.test(arg)) && !args.includes('-vn'))
            || args.some(arg => /\/core\/render\/(?:video\.mjs|record\.mjs|mux\.sh)$/.test(arg))) {
          active.add('render');
        }
        if (command === 'edge-tts' || args.some(arg => /(?:^|\/)(?:tts_zh\.py|tts\.py|asr_check\.py|edge-tts)$/.test(arg))) {
          active.add('speech');
        }
      } catch {
        // A process disappearing in this sample does not affect the task.
      }
    }
  }
  return active;
}

/** Per-task wall time at one-second sampling resolution. Activity can overlap across categories. */
export function observeCodeFilmWork(daemonPid: number | undefined) {
  const totals = { renderProcessMs: 0, speechProcessMs: 0, sampledMs: 0, sampleErrors: 0 };
  let previous = performance.now();
  let wasActive = new Set<Work>();
  function tick() {
    const now = performance.now();
    const elapsed = now - previous;
    previous = now;
    // Long event-loop stalls leave a gap instead of attributing the whole gap to old observations.
    const observed = Math.min(1_200, elapsed);
    totals.sampledMs += observed;
    if (wasActive.has('render')) totals.renderProcessMs += observed;
    if (wasActive.has('speech')) totals.speechProcessMs += observed;
    try { wasActive = activeFilmWork(daemonPid!); }
    catch { totals.sampleErrors++; wasActive = new Set(); }
  }
  const timer = daemonPid && process.platform === 'linux' ? setInterval(tick, 1_000) : undefined;
  timer?.unref();
  return () => {
    if (timer) {
      clearInterval(timer);
      tick();
    }
    return {
      renderProcessMs: Math.round(totals.renderProcessMs),
      speechProcessMs: Math.round(totals.speechProcessMs),
      sampledMs: Math.round(totals.sampledMs),
      sampleErrors: totals.sampleErrors,
    };
  };
}
