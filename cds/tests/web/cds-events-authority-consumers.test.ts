import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
const routerReact = createRequire(path.resolve('web/package.json'))('react');
// Execute actual component bodies/effects against controlled async API responses; no DOM/visual verdict.
const h = vi.hoisted(() => ({ current: null as any, epoch: 0, events: {} as any, calls: [] as Array<{ url: string; resolve: (data: any) => void }> }));
vi.mock('react', async original => {
  const actual = await original<any>();
  const slot = () => { const r = h.current, i = r.index++; return { r, i }; };
  const equal = (a: any[], b: any[]) => !!a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const memo = (fn: () => any, deps: any[]) => { const { r, i } = slot(); if (!r.memo[i] || !equal(r.memo[i].deps, deps)) r.memo[i] = { deps, value: fn() }; return r.memo[i].value; };
  return { ...actual,
    useState: (value: any) => { const { r, i } = slot(); if (!(i in r.values)) r.values[i] = typeof value === 'function' ? value() : value; return [r.values[i], (next: any) => { r.values[i] = typeof next === 'function' ? next(r.values[i]) : next; }]; },
    useRef: (value: any) => memo(() => ({ current: value }), []),
    useCallback: (fn: any, deps: any[]) => memo(() => fn, deps), useMemo: memo,
    useEffect: (fn: () => any, deps: any[]) => { const { r, i } = slot(); const prior = r.effects[i]; if (!prior || !equal(prior.deps, deps)) { r.pending.push(() => { prior?.cleanup?.(); r.effects[i] = { deps, cleanup: fn() }; }); } },
  };
});
vi.mock('@/hooks/useCdsEvents', () => ({ useCdsEvents: () => ({ connectionEpoch: h.epoch, effectiveConnection: 'connected', ...h.events }) }));
vi.mock('@/lib/api', () => ({ apiUrl: (path: string) => path, ApiError: class extends Error {}, apiRequest: (url: string) => new Promise(resolve => h.calls.push({ url, resolve })) }));
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
let runner: any;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function render(Component: any) { runner.index = 0; h.current = runner; Component({}); for (const effect of runner.pending.splice(0)) effect(); }
function data(id: string) { const item = { id, sessionId: id, status: 'pending', composeYaml: 'owned' }; return { requests: [item], imports: [item], pending: [item], notices: [item], items: [item], users: [], apps: [], liveCount: 0, historyCount: 1 }; }
beforeEach(() => {
  routerReact.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = { useContext: () => ({ matches: [{ params: { projectId: 'owned-project' } }] }) };
  runner = { index: 0, values: [], memo: [], effects: [], pending: [] }; h.epoch = 0; h.events = {}; h.calls = [];
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
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
it.each(cases)('%s prevents a late earlier request from overwriting an event-triggered authoritative read', async (_name, Component, endpoint) => {
  render(Component); const initial = h.calls.filter(call => call.url.startsWith(endpoint)); const before = h.calls.length;
  h.events = { lastPendingImportEvent: { ts: 'new' }, lastAccessRequestEvent: { ts: 'new' }, lastOperatorRequestEvent: { ts: 'new' }, lastNoticeEvent: { ts: 'new' }, lastAgentActivityEvent: { ts: 'new', projectId: 'owned-project' } };
  render(Component); const next = h.calls.slice(before).filter(call => call.url.startsWith(endpoint)); expect(next.length).toBeGreaterThan(0);
  next.forEach(call => call.resolve(data('new-current'))); await tick(); initial.forEach(call => call.resolve(data('late-old'))); await tick();
  expect(JSON.stringify(runner.values)).not.toContain('late-old');
});
it.each(cases)('%s invalidates outstanding reads on unmount without manufacturing a terminal state', async (_name, Component, endpoint) => {
  render(Component); const requests = h.calls.filter(call => call.url.startsWith(endpoint));
  for (const effect of runner.effects) effect?.cleanup?.();
  requests.forEach(call => call.resolve(data('after-unmount'))); await tick();
  expect(JSON.stringify(runner.values)).not.toContain('after-unmount');
});
