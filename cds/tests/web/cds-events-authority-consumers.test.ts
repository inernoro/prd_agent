import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
const routerReact = createRequire(path.resolve('web/package.json'))('react');
// Execute actual component bodies/effects against controlled async API responses; no DOM/visual verdict.
const h = vi.hoisted(() => ({ current: null as any, epoch: 0, events: {} as any, calls: [] as Array<{ url: string; options?: any; resolve: (data: any) => void }> }));
vi.mock('react', async original => {
  const actual = await original<any>();
  const slot = () => { const r = h.current, i = r.index++; return { r, i }; };
  const equal = (a: any[], b: any[]) => !!a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const memo = (fn: () => any, deps: any[]) => { const { r, i } = slot(); if (!r.memo[i] || !equal(r.memo[i].deps, deps)) r.memo[i] = { deps, value: fn() }; return r.memo[i].value; };
  return { ...actual,
    useState: (value: any) => { const { r, i } = slot(); if (!(i in r.values)) r.values[i] = typeof value === 'function' ? value() : value; return [r.values[i], (next: any) => { if (!r.mounted) r.afterUnmount++; r.values[i] = typeof next === 'function' ? next(r.values[i]) : next; }]; },
    useRef: (value: any) => memo(() => ({ current: value }), []),
    useCallback: (fn: any, deps: any[]) => memo(() => fn, deps), useMemo: memo,
    useEffect: (fn: () => any, deps: any[]) => { const { r, i } = slot(); const prior = r.effects[i]; if (!prior || !equal(prior.deps, deps)) { r.pending.push(() => { prior?.cleanup?.(); r.effects[i] = { deps, cleanup: fn() }; }); } },
  };
});
vi.mock('@/hooks/useCdsEvents', () => ({ useCdsEvents: () => ({ connectionEpoch: h.epoch, effectiveConnection: 'connected', ...h.events }) }));
vi.mock('@/lib/api', () => ({ apiUrl: (path: string) => path, ApiError: class extends Error {}, apiRequest: (url: string, options?: any) => new Promise(resolve => h.calls.push({ url, options, resolve })) }));
vi.mock('react-dom', () => ({ createPortal: (node: any) => node }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ projectId: 'owned-project' }), Link: () => null }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: () => null, Crumb: () => null, TopBar: () => null, Workspace: () => null }));
vi.mock('@/lib/useOverlayDock', () => ({ useOverlayDock: () => null }));
vi.mock('@/components/GlobalUpdateBadge', () => ({ GlobalUpdateBadge: () => null }));
vi.mock('@/components/CommitInbox', () => ({ CommitInbox: () => null }));
import { PendingImportInbox } from '../../web/src/components/PendingImportInbox.js';
import { AccessRequestInbox } from '../../web/src/components/AccessRequestInbox.js';
import { OperatorApprovalModal } from '../../web/src/components/OperatorApprovalModal.js';
import { SiteNoticeInbox } from '../../web/src/components/SiteNoticeInbox.js';
import { AgentRequestsPage } from '../../web/src/pages/AgentRequestsPage.js';
const cases = [
  ['imports', PendingImportInbox, '/api/pending-imports'], ['access', AccessRequestInbox, '/api/access-requests'],
  ['operator', OperatorApprovalModal, '/api/cds-system/operator/requests'], ['notices', SiteNoticeInbox, '/api/notices'],
  ['agents', AgentRequestsPage, '/api/projects/owned-project/agent-requests?'],
] as const;
let runner: any, timers: Array<() => void>, cancelled: Set<number>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function render(Component: any) { runner.index = 0; h.current = runner; Component({}); for (const effect of runner.pending.splice(0)) effect(); }
function data(id: string) { const item = { id, sessionId: id, status: 'pending', composeYaml: 'owned', createdAt: '2026-10-11T00:00:00Z', submittedAt: '2026-10-11T00:00:00Z', opDanger: 'safe', title: 'owned', summary: { addedProfiles: [], addedInfra: [], addedEnvKeys: [] } }; return { requests: [item], imports: [item], pending: [item], notices: [item], items: [item], users: [], apps: [], liveCount: 0, historyCount: 1 }; }
beforeEach(() => {
  routerReact.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = { useContext: () => ({ location: { pathname: '/', search: '' }, matches: [{ params: { projectId: 'owned-project' } }] }) };
  runner = { index: 0, values: [], memo: [], effects: [], pending: [], mounted: true, afterUnmount: 0 }; timers = []; cancelled = new Set(); h.epoch = 0; h.events = {}; h.calls = [];
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: (id: number) => cancelled.add(id) });
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => { routerReact.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = null; for (const effect of runner.effects) effect?.cleanup?.(); for (const call of h.calls) call.resolve(data('cleanup')); vi.unstubAllGlobals(); });
it.each(cases)('%s rereads its authoritative API on a new connection generation without needing an event', async (_name, Component, endpoint) => {
  render(Component); const initial = h.calls.filter(call => call.url.startsWith(endpoint)); expect(initial.length).toBeGreaterThan(0);
  const before = h.calls.length; render(Component); expect(h.calls).toHaveLength(before);
  h.epoch = 1; render(Component); const next = h.calls.slice(before).filter(call => call.url.startsWith(endpoint));
  expect(next.length).toBeGreaterThan(0); next.forEach(call => call.resolve(data('new-current'))); await tick();
  initial.forEach(call => call.resolve(data('late-old'))); await tick();
  expect(JSON.stringify(runner.values)).toContain('new-current'); expect(JSON.stringify(runner.values)).not.toContain('late-old');
});
it.each(cases)('%s shows a same-generation snapshot and then executes one latest authoritative followup', async (_name, Component, endpoint) => {
  render(Component); const initial = h.calls.filter(call => call.url.startsWith(endpoint)); const before = h.calls.length;
  h.events = { lastPendingImportEvent: { ts: 'new' }, lastAccessRequestEvent: { ts: 'new' }, lastOperatorRequestEvent: { ts: 'new' }, lastNoticeEvent: { ts: 'new' }, lastAgentActivityEvent: { ts: 'new', projectId: 'owned-project' } };
  render(Component); expect(h.calls).toHaveLength(before);
  initial.forEach(call => call.resolve(data('late-old'))); await tick();
  expect(JSON.stringify(runner.values)).toContain('late-old');
  const next = h.calls.slice(before).filter(call => call.url.startsWith(endpoint)); expect(next).toHaveLength(1);
  next.forEach(call => call.resolve(data('new-current'))); await tick();
  expect(JSON.stringify(runner.values)).toContain('new-current'); expect(JSON.stringify(runner.values)).not.toContain('late-old');
});
it.each(cases)('%s invalidates outstanding reads on unmount without manufacturing a terminal state', async (_name, Component, endpoint) => {
  render(Component); const requests = h.calls.filter(call => call.url.startsWith(endpoint));
  for (const effect of runner.effects) effect?.cleanup?.();
  requests.forEach(call => call.resolve(data('after-unmount'))); await tick();
  expect(JSON.stringify(runner.values)).not.toContain('after-unmount');
});

function unmount() { runner.mounted = false; for (const effect of runner.effects) effect?.cleanup?.(); }
async function showPending(Component: any, endpoint: string) {
  render(Component); h.calls.filter(call => call.url === endpoint).forEach(call => call.resolve(data('decided-item')));
  await tick(); render(Component);
}
function command(action: 'approve' | 'reject') {
  const fn = runner.memo.map((slot: any) => slot?.value).find((value: any) => typeof value === 'function' && value.toString().includes('/' + action));
  expect(fn).toBeTypeOf('function'); return fn;
}
const decisions = cases.slice(0, 3).flatMap(([name, Component, endpoint]) => (['approve', 'reject'] as const).map(action => [name, Component, endpoint, action] as const));
it.each(decisions)('%s decision fences reads issued before the successful POST (%#)', async (_name, Component, endpoint, action) => {
  await showPending(Component, endpoint);
  h.events = { lastPendingImportEvent: { ts: 'race' }, lastAccessRequestEvent: { ts: 'race' }, lastOperatorRequestEvent: { ts: 'race' } };
  const before = h.calls.length; render(Component); const stale = h.calls.slice(before).filter(call => call.url === endpoint);
  expect(stale.length).toBeGreaterThan(0);
  const job = command(action)(_name === 'operator' ? 'once' : 'decided-item');
  h.calls.filter(call => call.options?.method === 'POST').forEach(call => call.resolve({ ok: true })); await job;
  stale.forEach(call => call.resolve(data('decided-item'))); await tick();
  expect(JSON.stringify(runner.values)).not.toContain('decided-item');
});
it.each(decisions)('%s decision completion after unmount performs no state writes (%#)', async (_name, Component, endpoint, action) => {
  await showPending(Component, endpoint); const job = command(action)(_name === 'operator' ? 'once' : 'decided-item');
  unmount(); h.calls.filter(call => call.options?.method === 'POST').forEach(call => call.resolve({ ok: true })); await job;
  expect(runner.afterUnmount).toBe(0); expect(timers).toHaveLength(0);
});
it('operator cancels the delayed refresh and fences even an already queued timer callback after unmount', async () => {
  await showPending(OperatorApprovalModal, '/api/cds-system/operator/requests'); const job = command('approve')('once');
  h.calls.filter(call => call.options?.method === 'POST').forEach(call => call.resolve({ ok: true })); await job;
  expect(timers).toHaveLength(1); const before = h.calls.length; unmount(); timers.forEach(fn => fn());
  expect(cancelled.has(1)).toBe(true); expect(h.calls).toHaveLength(before); expect(runner.afterUnmount).toBe(0);
});

it.each(cases)('%s coalesces 100 held event reads into one active and one authoritative followup', async (_name, Component, endpoint) => {
  render(Component);
  for (let n = 0; n < 100; n++) {
    h.events = { lastPendingImportEvent: { ts: String(n) }, lastAccessRequestEvent: { ts: String(n) }, lastOperatorRequestEvent: { ts: String(n) }, lastNoticeEvent: { ts: String(n) }, lastAgentActivityEvent: { ts: String(n), projectId: 'owned-project' } };
    render(Component);
  }
  const active = h.calls.filter(call => call.url.startsWith(endpoint)); expect(active).toHaveLength(1);
  active.forEach(call => call.resolve(data('superseded-read'))); await tick();
  const followup = h.calls.filter(call => call.url.startsWith(endpoint)).slice(1); expect(followup).toHaveLength(1);
  expect(JSON.stringify(runner.values)).toContain('superseded-read');
  followup.forEach(call => call.resolve(data('current-authority'))); await tick();
  expect(JSON.stringify(runner.values)).toContain('current-authority');
  expect(h.calls.filter(call => call.url.startsWith(endpoint))).toHaveLength(2);
});
it.each(cases)('%s deadline releases ignored-abort reads without writing a late stale response', async (_name, Component, endpoint) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    render(Component); const first = h.calls.filter(call => call.url.startsWith(endpoint));
    h.events = { lastPendingImportEvent: { ts: 'timeout' }, lastAccessRequestEvent: { ts: 'timeout' }, lastOperatorRequestEvent: { ts: 'timeout' }, lastNoticeEvent: { ts: 'timeout' }, lastAgentActivityEvent: { ts: 'timeout', projectId: 'owned-project' } };
    render(Component); await vi.advanceTimersByTimeAsync(5000); await tick();
    const all = h.calls.filter(call => call.url.startsWith(endpoint)); expect(all).toHaveLength(2); expect(first[0].options.signal.aborted).toBe(true);
    all[1].resolve(data('deadline-current')); await tick(); first[0].resolve(data('deadline-old')); await tick();
    expect(JSON.stringify(runner.values)).toContain('deadline-current'); expect(JSON.stringify(runner.values)).not.toContain('deadline-old');
    unmount(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('import hydration keeps every YAML while limiting detail reads to four per observation', async () => {
  render(PendingImportInbox); const list = h.calls.find(call => call.url === '/api/pending-imports')!;
  list.resolve({ imports: Array.from({ length: 9 }, (_, n) => ({ id: 'detail-' + n, status: 'pending' })) }); await tick();
  let resolved = 0, peak = 0;
  while (resolved < 9) {
    const active = h.calls.filter(call => call.url.startsWith('/api/pending-imports/')).slice(resolved);
    expect(active.length).toBeGreaterThan(0); peak = Math.max(peak, active.length); expect(active.length).toBeLessThanOrEqual(4);
    for (const call of active) call.resolve({ import: { composeYaml: 'yaml-for-' + call.url.split('/').at(-1) } });
    resolved += active.length; await tick();
  }
  expect(peak).toBe(4);
  for (let n = 0; n < 9; n++) expect(JSON.stringify(runner.values)).toContain('yaml-for-detail-' + n);
});
it('unmount aborts import hydration and starts no remaining details or state writes', async () => {
  render(PendingImportInbox); h.calls[0].resolve({ imports: Array.from({ length: 9 }, (_, n) => ({ id: 'detail-' + n, status: 'pending' })) }); await tick();
  const before = h.calls.length, details = h.calls.slice(1); expect(details).toHaveLength(4); unmount();
  details.forEach(call => call.resolve({ import: { composeYaml: 'after-unmount' } })); await tick();
  expect(h.calls).toHaveLength(before); expect(details.every(call => call.options.signal.aborted)).toBe(true); expect(runner.afterUnmount).toBe(0);
});
it.each(decisions)('%s successful decision rereads authoritative pending even if no later event arrives (%#)', async (_name, Component, endpoint, action) => {
  await showPending(Component, endpoint);
  h.events = { lastPendingImportEvent: { ts: 'first' }, lastAccessRequestEvent: { ts: 'first' }, lastOperatorRequestEvent: { ts: 'first' } };
  render(Component); const old = h.calls.filter(call => call.url === endpoint).at(-1)!;
  h.events = { lastPendingImportEvent: { ts: 'dirty' }, lastAccessRequestEvent: { ts: 'dirty' }, lastOperatorRequestEvent: { ts: 'dirty' } }; render(Component);
  const job = command(action)(_name === 'operator' ? 'once' : 'decided-item'); const before = h.calls.length;
  h.calls.filter(call => call.options?.method === 'POST').forEach(call => call.resolve({ ok: true })); await job;
  const fresh = h.calls.slice(before).filter(call => call.url === endpoint); expect(fresh).toHaveLength(1);
  fresh[0].resolve(data('another-pending')); await tick(); old.resolve(data('decided-item')); await tick();
  expect(JSON.stringify(runner.values)).toContain('another-pending'); expect(JSON.stringify(runner.values)).not.toContain('decided-item');
});
it.each(cases)('%s remains observable during continuous signals while keeping one read and one demand', async (_name, Component, endpoint) => {
  render(Component);
  for (let round = 0; round < 5; round++) {
    h.events = { lastPendingImportEvent: { ts: String(round) }, lastAccessRequestEvent: { ts: String(round) }, lastOperatorRequestEvent: { ts: String(round) }, lastNoticeEvent: { ts: String(round) }, lastAgentActivityEvent: { ts: String(round), projectId: 'owned-project' } };
    render(Component); const read = h.calls.filter(call => call.url.startsWith(endpoint))[round]; read.resolve(data('visible-' + round)); await tick();
    expect(JSON.stringify(runner.values)).toContain('visible-' + round); expect(h.calls.filter(call => call.url.startsWith(endpoint))).toHaveLength(round + 2);
  }
});
