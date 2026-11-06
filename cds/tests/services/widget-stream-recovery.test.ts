import { afterEach, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { buildWidgetScript } from '../../src/widget-script.js';

class Source {
  static instances: Source[] = [];
  handlers = new Map<string, (event: { data: string }) => void>();
  onerror?: () => void;
  closed = false;
  constructor(readonly url: string) { Source.instances.push(this); }
  addEventListener(name: string, handler: (event: { data: string }) => void) { this.handlers.set(name, handler); }
  close() { this.closed = true; }
  emit(name: string, data: unknown) { this.handlers.get(name)?.({ data: JSON.stringify(data) }); }
}

function client() {
  Source.instances = [];
  vi.useFakeTimers();
  const script = buildWidgetScript('owned', 'main');
  const terminal: string[] = [];
  const state: Record<string, any> = {
    API: '/_cds/api', BRANCH_ID: 'owned', BRANCH_NAME: 'main',
    branchStatus: 'building', branchConnectionState: 'connecting', branchTags: [], branchEventSource: null,
    branchStreamRetryTimer: null, branchInfoFetchTimer: null, syncClearTimer: null,
    syncState: { visible: true, phase: 'syncing', progress: 34, stepsSeen: {} },
    profiles: [], commitSha: '', commitMsg: '', branchInfoFetchSequence: 0,
    EventSource: Source, setTimeout, clearTimeout,
    render: () => { terminal.push(state.syncState.phase); },
    unwatchTitle: () => {},
    fetch: async (url: string) => ({ ok: true, json: async () => url.endsWith('/branches')
      ? { tabTitleEnabled: false, branches: [{ id: 'owned', projectId: 'project-owned', status: 'error', runningCommitSha: 'a'.repeat(40) }] }
      : { profiles: [] } }),
  };
  vm.createContext(state);
  vm.runInContext(script.slice(script.indexOf('function shortSha('), script.indexOf('  var root=document.createElement')), state);
  vm.runInContext(script.slice(script.indexOf('function fetchBranchInfo(){'), script.indexOf('function fetchContainerLog(')), state);
  state.initBranchStream();
  return { state, terminal };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(['forbidden', 'unavailable'])('已知%s随后真实连接关闭的onerror不能抹去原因，下一次授权补读成功才恢复', async reason => {
  const { state } = client();
  Source.instances[0].emit('cds.transport', { state: reason });
  Source.instances[0].onerror?.();
  expect(state.branchConnectionState).toBe(reason);
  await vi.advanceTimersByTimeAsync(3000);
  expect(Source.instances).toHaveLength(2); // 保留原重连动作，不引入永久禁重连。
  Source.instances[1].emit('cds.transport', { state: 'reconnecting' });
  Source.instances[1].onerror?.();
  expect(state.branchConnectionState).toBe(reason);
  await vi.advanceTimersByTimeAsync(3000);
  expect(Source.instances).toHaveLength(3);
  Source.instances[2].emit('cds.transport', { state: 'connected' });
  Source.instances[2].emit('snapshot', {});
  await vi.advanceTimersByTimeAsync(1);
  expect(state.branchConnectionState).toBe('connected');
  expect(state.branchStatus).toBe('error');
});

it('重连快照触发真实权威补读，补到离线期间的失败终态', async () => {
  const { state } = client();
  Source.instances[0].emit('snapshot', { branches: [{ id: 'unrelated', status: 'running' }] });
  await vi.advanceTimersByTimeAsync(1);
  expect(state.branchStatus).toBe('error');
  expect(state.syncState.phase).toBe('error');
});

it('重复错误只安排一个重连，替换后的旧流不能改写当前分支状态', async () => {
  const { state } = client();
  const old = Source.instances[0];
  old.onerror?.(); old.onerror?.(); old.onerror?.();
  await vi.advanceTimersByTimeAsync(3000);
  expect(Source.instances).toHaveLength(2);
  state.branchStatus = 'running';
  old.emit('branch.status', { branchId: 'owned', status: 'error' });
  expect(state.branchStatus).toBe('running');
  expect(old.closed).toBe(true);
});

it('Bridge关闭时不订阅没有消费者的AI活动流，启用后保留该能力', () => {
  const { state } = client();
  const script = buildWidgetScript('owned', 'main');
  state.BRIDGE_ENABLED = false;
  vm.runInContext(script.slice(script.indexOf('function initAiStream(){'), script.indexOf('  // Periodic TTL check')), state);
  state.initAiStream();
  expect(Source.instances).toHaveLength(1);
  state.BRIDGE_ENABLED = true;
  state.initAiStream();
  expect(Source.instances).toHaveLength(2);
});

it('先发后到的旧权威读取不能覆盖已恢复的失败终态', async () => {
  const { state } = client();
  let release!: (value: unknown) => void;
  const first = new Promise(resolve => { release = resolve; });
  let reads = 0;
  state.fetch = async (url: string) => {
    if (url.endsWith('/branches') && ++reads === 1) return first;
    return { ok: true, json: async () => url.endsWith('/branches')
      ? { tabTitleEnabled: false, branches: [{ id: 'owned', status: 'error' }] }
      : { profiles: [] } };
  };
  state.fetchBranchInfo(); state.fetchBranchInfo();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.branchStatus).toBe('error');
  release({ ok: true, json: async () => ({ tabTitleEnabled: false, branches: [{ id: 'owned', status: 'running' }] }) });
  await vi.advanceTimersByTimeAsync(1);
  expect(state.branchStatus).toBe('error');
});

it('传输恢复不是分支健康，必须等权威补读；读取失败明确不可用且不伪造注销', async () => {
  const { state } = client();
  const source = Source.instances[0];
  state.branchStatus = 'running';
  source.emit('cds.transport', { state: 'reconnecting' });
  expect(state.branchConnectionState).toBe('reconnecting');
  source.emit('cds.transport', { state: 'connected' });
  expect(state.branchConnectionState).toBe('refreshing');
  state.fetch = async () => ({ ok: false });
  state.fetchBranchInfo();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.branchConnectionState).toBe('unavailable');
  expect(state.branchStatus).toBe('running');
  state.fetch = async (url: string) => ({ ok: true, json: async () => url.endsWith('/branches')
    ? { tabTitleEnabled: false, branches: [{ id: 'owned', status: 'error' }] } : { profiles: [] } });
  source.emit('snapshot', {});
  await vi.advanceTimersByTimeAsync(1);
  expect(state.branchConnectionState).toBe('connected');
  expect(state.branchStatus).toBe('error');
});

it('上游明确进入恢复后，之前尚未返回的读取不能把未知状态刷绿', async () => {
  const { state } = client();
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  state.fetch = async (url: string) => url.endsWith('/branches') ? pending
    : { ok: true, json: async () => ({ profiles: [] }) };
  state.fetchBranchInfo();
  Source.instances[0].emit('cds.transport', { state: 'reconnecting' });
  release({ ok: true, json: async () => ({ tabTitleEnabled: false, branches: [{ id: 'owned', status: 'running' }] }) });
  await vi.advanceTimersByTimeAsync(1);
  expect(state.branchConnectionState).toBe('reconnecting');
  expect(state.branchStatus).toBe('building');
});
