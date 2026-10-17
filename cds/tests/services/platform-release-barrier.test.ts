import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceWorkGroup, PlatformReleaseBarrier, type ReleaseParticipant } from '../../src/services/platform-release-barrier.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { ReleaseService } from '../../src/services/release-service.js';
import type { StateService } from '../../src/services/state.js';
import type { ReleaseTarget } from '../../src/types.js';

const runtime = { pid: 1234, startedAt: '2026-10-15T01:00:00Z', commitSha: 'a'.repeat(40) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('有明确所有者的平台发布屏障', () => {
  const setup = () => {
    const work = new MaintenanceWorkGroup();
    const barrier = new PlatformReleaseBarrier(new Map([['work', work]]), ['work'], () => runtime);
    return { work, barrier };
  };
  it('空闲、落盘成功后才可封闭；持有者不能被另一发布或伪造凭据替换', async () => {
    const { work, barrier } = setup();
    const owner = barrier.begin(runtime);
    expect(() => barrier.begin(runtime)).toThrow('已有');
    expect(() => barrier.abort({ ...owner })).toThrow('所有者');
    expect(() => work.run('new', () => 1)).toThrow('维护');
    await barrier.seal(owner, { timeoutMs: 1000, flush: async () => {} });
    barrier.commit(owner);
    expect(barrier.snapshot().phase).toBe('committing');
    expect(() => barrier.abort(owner)).toThrow();
    barrier.requireRecovery(owner);
    expect(() => barrier.rollbackComplete(owner, () => false)).toThrow('回退');
    barrier.rollbackComplete(owner, () => true);
    expect(work.run('resumed', () => 42)).toBe(42);
  });
  it('已受理任务可继续派生子工作，新任务拒绝；超时不取消已受理任务', async () => {
    const { work, barrier } = setup();
    const pause = deferred<void>();
    let continued = false;
    const task = work.run('accepted', async () => {
      await pause.promise;
      await work.run('accepted-child', async () => { continued = true; });
    });
    const owner = barrier.begin(runtime);
    await expect(barrier.seal(owner, { timeoutMs: 30, flush: async () => {} })).rejects.toThrow('超时');
    expect(barrier.snapshot().blockers).toHaveLength(1);
    expect(() => work.run('late', () => {})).toThrow('维护');
    pause.resolve(); await task;
    expect(continued).toBe(true);
    await barrier.seal(owner, { timeoutMs: 1000, flush: async () => {} });
    barrier.abort(owner);
  });
  it('落盘超时后实际写入仍在执行时，不能提前恢复准入', async () => {
    const { work, barrier } = setup();
    const writing = deferred<void>();
    const owner = barrier.begin(runtime);
    await expect(barrier.seal(owner, { timeoutMs: 25, flush: () => writing.promise })).rejects.toThrow('落盘超时');
    expect(barrier.snapshot().pendingControl).toBe(1);
    expect(() => barrier.abort(owner)).toThrow('仍在执行');
    expect(() => work.run('late', () => {})).toThrow('维护');
    writing.resolve(); await writing.promise; await Promise.resolve();
    barrier.abort(owner);
    expect(barrier.snapshot().phase).toBe('open');
  });
  it('提交阶段不会因时间流逝而放开屏障', async () => {
    const { work, barrier } = setup();
    const owner = barrier.begin(runtime);
    await barrier.seal(owner, { timeoutMs: 1000, flush: async () => {} });
    barrier.commit(owner);
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(() => work.run('next-day', () => {})).toThrow('维护');
    expect(barrier.snapshot().phase).toBe('committing');
  });
  it('取消落盘等待立即返回，但真实写入结束前不能撤销屏障', async () => {
    const { work, barrier } = setup();
    const writing = deferred<void>(), started = deferred<void>();
    const cancel = new AbortController();
    const owner = barrier.begin(runtime);
    const sealing = barrier.seal(owner, { timeoutMs: 60_000, signal: cancel.signal, flush: () => {
      started.resolve(); return writing.promise;
    } });
    const rejected = expect(sealing).rejects.toThrow('已取消');
    await started.promise; cancel.abort(); await rejected;
    expect(() => barrier.abort(owner)).toThrow('仍在执行');
    expect(() => work.run('late', () => {})).toThrow('维护');
    writing.resolve(); await writing.promise; await Promise.resolve();
    barrier.abort(owner);
  });
  it('父任务结束后遗留的异步上下文不能绕过新任务准入', async () => {
    const { work, barrier } = setup();
    const release = deferred<void>();
    let late!: Promise<number>;
    work.run('accepted', () => {
      late = release.promise.then(() => work.run('orphan-child', () => 1));
    });
    const owner = barrier.begin(runtime);
    const rejected = expect(late).rejects.toThrow('维护');
    release.resolve(); await rejected;
    await barrier.seal(owner, { timeoutMs: 1000, flush: async () => {} });
    barrier.abort(owner);
  });
  it.each(['unknown', 'snapshot-error', 'flush-error', 'late-blocker', 'pid-drift', 'sha-drift', 'cancel'] as const)
  ('%s 拒绝最终封闭或换盘', async failure => {
    let block = false;
    let identity = { ...runtime };
    const participant: ReleaseParticipant = { closeAdmission: () => ({ reopen: () => {}, inspect: () => {
      if (failure === 'snapshot-error') throw new Error('unknown');
      return { known: failure !== 'unknown', blockers: block ? [{ kind: 'late', id: 'operation' }] : [] };
    } }) };
    const barrier = new PlatformReleaseBarrier(new Map([['work', participant]]), ['work'], () => identity);
    const owner = barrier.begin(runtime), cancel = new AbortController();
    if (failure === 'cancel') cancel.abort();
    await expect(barrier.seal(owner, { timeoutMs: 30, signal: cancel.signal, flush: async () => {
      if (failure === 'flush-error') throw new Error('flush failed');
      if (failure === 'late-blocker') block = true;
      if (failure === 'pid-drift') identity = { ...runtime, pid: 4321 };
      if (failure === 'sha-drift') identity = { ...runtime, commitSha: 'b'.repeat(40) };
    } })).rejects.toThrow();
    expect(() => barrier.commit(owner)).toThrow();
    expect(barrier.snapshot().phase).toBe('draining');
    barrier.abort(owner);
  });
  it('缺少参与者或无法确认完整运行身份，禁止取得屏障', () => {
    const barrier = new PlatformReleaseBarrier(new Map(), ['http', 'background'], () => runtime);
    expect(() => barrier.begin(runtime)).toThrow('覆盖不完整');
    expect(() => barrier.begin({ ...runtime, commitSha: 'abc' })).toThrow('身份');
    expect(barrier.snapshot().phase).toBe('open');
  });
  it('半途取得参与者失败会释放已取得的闸门', () => {
    const work = new MaintenanceWorkGroup();
    const barrier = new PlatformReleaseBarrier(new Map<string, ReleaseParticipant>([
      ['work', work], ['failure', { closeAdmission: () => { throw new Error('busy'); } }],
    ]), ['work', 'failure'], () => runtime);
    expect(() => barrier.begin(runtime)).toThrow('busy');
    expect(work.run('normal', () => 1)).toBe(1);
  });
});

describe('真实业务入口接入发布参与者', () => {
  const request = { projectId: 'p', branchId: 'b', kind: 'deploy' as const, trigger: 'manual' as const };
  it('分支执行已取消资格但尚未 complete，仍不能进入发布', () => {
    const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin(request).lease!;
    coordinator.cancelBranch('b', 'test');
    expect(coordinator.getActiveOperations()).toHaveLength(0);
    expect(() => coordinator.releaseParticipant().closeAdmission()).toThrow('仍有');
    coordinator.complete(lease, 'cancelled');
    const hold = coordinator.releaseParticipant().closeAdmission();
    expect(coordinator.begin(request).status).toBe('rejected');
    expect(() => coordinator.beginDeploymentPreparation(request)).toThrow('维护');
    expect(coordinator.drainReady()).toEqual([]);
    hold.reopen(); expect(coordinator.begin(request).status).toBe('started');
  });
  it('被取代的准备读取和未派发待办仍是发布阻塞项', () => {
    const coordinator = new BranchOperationCoordinator();
    const preparation = coordinator.beginDeploymentPreparation({ ...request, commitSha: 'a'.repeat(40) });
    coordinator.cancelBranch('b', 'test');
    expect(() => coordinator.releaseParticipant().closeAdmission()).toThrow();
    preparation.release();
    const lease = coordinator.begin(request).lease!;
    coordinator.begin({ ...request, trigger: 'webhook', commitSha: 'b'.repeat(40) });
    expect(() => coordinator.releaseParticipant().closeAdmission()).toThrow();
    const pending = coordinator.complete(lease, 'completed');
    expect(pending).not.toBeNull();
    expect(() => coordinator.releaseParticipant().closeAdmission()).toThrow();
  });
  it('发布前检查等待期间仍算受理中的工作，新发布和回滚均拒绝', async () => {
    const service = new ReleaseService({ getBranch: () => undefined, getReleaseTarget: () => undefined,
      getReleasePreflights: () => [] } as unknown as StateService);
    const preflight = deferred<any>();
    vi.spyOn(service, 'preflight').mockImplementation(() => preflight.promise);
    const running = service.startRelease({ branchId: 'b', targetId: 't', planId: 'p' });
    const rejected = expect(running).rejects.toThrow('发布前检查');
    const hold = service.releaseParticipant().closeAdmission();
    expect(hold.inspect().blockers.length).toBeGreaterThan(0);
    await expect(service.startRelease({ branchId: 'b', targetId: 't', planId: 'p' })).rejects.toThrow('维护');
    await expect(service.startRollback('old')).rejects.toThrow('维护');
    preflight.resolve({ ok: false, checks: [] }); await rejected;
    expect(hold.inspect().blockers).toEqual([]); hold.reopen();
  });
  it('远端 SSH 读操作直到真实返回才释放，新产物回收不再进入', async () => {
    const ssh = deferred<string>();
    const service = new ReleaseService({ getRemoteHost: () => ({ id: 'host' }) } as unknown as StateService,
      { sshExecutor: () => ssh.promise });
    const target = { id: 'target', type: 'ssh', ssh: { appPath: '/test', host: 'example.invalid', user: 'test' } } as unknown as ReleaseTarget;
    const reading = service.diskDiagnosis(target);
    const hold = service.releaseParticipant().closeAdmission();
    expect(hold.inspect().blockers).toHaveLength(1);
    await expect(service.reclaimRemoteReleaseArtifacts(target)).rejects.toThrow('维护');
    ssh.resolve('disk info'); await reading;
    expect(hold.inspect().blockers).toEqual([]); hold.reopen();
  });
});
