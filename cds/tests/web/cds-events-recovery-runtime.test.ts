import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ latest: null as any, read: null as null | (() => any) }));
vi.mock('react', () => ({
  useSyncExternalStore: (subscribe: any, read: any) => { harness.read = read; subscribe(() => { harness.latest = read(); }); harness.latest = read(); return harness.latest; },
  useEffect: (effect: any) => effect(),
}));
vi.mock('@/lib/api', () => ({ apiUrl: (value: string) => value }));
class Source {
  static all: Source[] = [];
  onopen?: () => void; onerror?: () => void; close = vi.fn();
  handlers = new Map<string, (event: any) => void>();
  constructor() { Source.all.push(this); }
  addEventListener(type: string, fn: any) { this.handlers.set(type, fn); }
  emit(type: string, data: any) { this.handlers.get(type)?.({ data: JSON.stringify({ type, ts: '2026-10-11T00:00:00Z', data }) }); }
}
let timers: Array<() => void>, mod: typeof import('../../web/src/hooks/useCdsEvents.js');
beforeEach(async () => {
  vi.resetModules(); Source.all = []; timers = [];
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' });
  mod = await import('../../web/src/hooks/useCdsEvents.js'); mod.useCdsEvents();
});
afterEach(() => { mod._resetForTests(); vi.unstubAllGlobals(); });
function reconnect() { const old = Source.all[0]; old.onerror!(); timers.shift()!(); const next = Source.all.at(-1)!; next.onopen!(); return { old, next }; }
it('increments recovery once per successful connection, never from heartbeat', () => {
  Source.all[0].onopen!(); expect(harness.latest.connectionEpoch).toBe(1);
  Source.all[0].emit('heartbeat', {}); expect(harness.latest.connectionEpoch).toBe(1);
  reconnect(); expect(harness.latest.connectionEpoch).toBe(2);
});
it('replaces lost busy observations from the reconnect snapshot instead of keeping missed terminal events forever', () => {
  Source.all[0].onopen!(); Source.all[0].emit('self.refresh.started', { jobId: 'old' }); Source.all[0].emit('self.update.started', { branch: 'old' });
  expect(harness.latest.updating).not.toBeNull(); const { next } = reconnect();
  next.emit('self.status', { currentBranch: 'new', activeSelfUpdate: null });
  expect(harness.latest.updating).toBeNull(); expect(harness.latest.refreshing).toBeNull();
  next.emit('self.status', { activeSelfUpdate: { startedAt: '2026-10-11T00:01:00Z', branch: 'new', step: 'pull', interrupted: false } });
  expect(harness.latest.updating).toMatchObject({ branch: 'new', step: 'pull' });
});
it('ignores late open, terminal and error callbacks from a replaced source', () => {
  Source.all[0].onopen!(); const { old, next } = reconnect(); next.emit('self.update.started', { branch: 'current' });
  old.onopen!(); old.emit('self.update.done', {}); old.onerror!();
  expect(harness.latest.updating).toMatchObject({ branch: 'current' });
  expect(harness.latest.connectionEpoch).toBe(2); expect(next.close).not.toHaveBeenCalled();
});

it.each(['', 'not-a-time'])('does not manufacture updating from malformed active startedAt %s', startedAt => {
  Source.all[0].onopen!(); Source.all[0].emit('self.status', { activeSelfUpdate: { startedAt, branch: 'owned', interrupted: false } });
  expect(harness.latest.updating).toBeNull();
});
