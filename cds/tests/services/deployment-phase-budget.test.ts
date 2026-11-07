import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeploymentPhaseBudget, restoreDeploymentMemoryReservations } from '../../src/services/deployment-phase-budget.js';

import { setBuildGateHostLoadProvider, type BuildLoadPressure } from '../../src/services/build-gate.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry } from '../../src/types.js';

describe('部署阶段容量准入', () => {
  beforeEach(() => setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 18 })));
  afterEach(() => setBuildGateHostLoadProvider(null));
  it('创建回执归还阶段槽后，未就绪的三份预留仍阻止第四次启动', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000);
    for (const projectId of ['a', 'b', 'c']) {
      const release = await budget.acquire('start', { projectId }, { reservationKey: projectId });
      release();
    }
    let admitted = false;
    const next = budget.acquire('start', { projectId: 'd' }, { reservationKey: 'd' }).then(release => {
      admitted = true; release();
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect((budget.snapshot().start as { queued: Array<{ reason: string }> }).queued[0].reason).toBe('cpu-startup-capacity');
    budget.releaseMemory('a'); await next;
    for (const key of ['b', 'c', 'd']) budget.releaseMemory(key);
  });

  it('宿主达到既有饱和线时只保留一份启动期预留，恢复容量后半秒内推进', async () => {
    let load1 = 18;
    setBuildGateHostLoadProvider(() => ({ load1, cores: 18 }));
    const budget = new DeploymentPhaseBudget(() => 10000);
    const first = await budget.acquire('start', { projectId: 'a' }, { reservationKey: 'a' });
    first();
    let admitted = false;
    const second = budget.acquire('start', { projectId: 'b' }, { reservationKey: 'b' }).then(release => {
      admitted = true; release();
    });
    await Promise.resolve(); expect(admitted).toBe(false);
    expect((budget.snapshot().start as { queued: Array<{ reason: string }> }).queued[0].reason).toBe('cpu-startup-capacity');
    load1 = 8; await second; expect(admitted).toBe(true);
    budget.releaseMemory('a'); budget.releaseMemory('b');
  });
  it('三个项目都有资格时，单项目积压不能使第三项目超过三个释放轮次才获准', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, { pull: 1 });
    const first = await budget.acquire('pull', { projectId: 'a' });
    const order: string[] = [];
    const jobs = [...Array(8).fill('a'), ...Array(8).fill('b'), 'c'].map(projectId =>
      budget.run('pull', { projectId }, async () => { order.push(projectId); }));
    first(); await Promise.all(jobs);
    expect(order.indexOf('c')).toBeLessThan(3);
    expect(order.slice(0, 3).sort()).toEqual(['a', 'b', 'c']);
  });

  it('拉取满额不阻塞就绪和清理；失败及重复归还不会泄漏名额', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, { pull: 1, start: 1, ready: 1, cleanup: 1 });
    const pull = await budget.acquire('pull', { projectId: 'a' });
    await expect(budget.run('ready', { projectId: 'b' }, async () => true)).resolves.toBe(true);
    await expect(budget.run('cleanup', { projectId: 'b' }, async () => { throw new Error('remove failed'); })).rejects.toThrow('remove failed');
    await expect(budget.run('cleanup', { projectId: 'c' }, async () => true)).resolves.toBe(true);
    pull(); pull();
    expect((budget.snapshot().pull as { active: unknown[] }).active).toHaveLength(0);
  });

  it('同一项目积压时不同项目轮流推进，不改变各项目内部先进先出', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, { pull: 1, start: 1, ready: 1, cleanup: 1 });
    const first = await budget.acquire('pull', { projectId: 'a' });
    const order: string[] = [];
    const jobs = ['a', 'a', 'b', 'c'].map((projectId, index) => budget.run('pull', { projectId }, async () => { order.push(`${projectId}${index}`); }));
    first(); await Promise.all(jobs);
    expect(order).toEqual(['b2', 'c3', 'a0', 'a1']);
  });

  it('内存不足保持等待；新增预留一起计入，资源恢复后推进，取消仍立即退队', async () => {
    let memory = 1600;
    const budget = new DeploymentPhaseBudget(() => memory);
    const first = await budget.acquire('start', { projectId: 'a' }, { memoryMB: 512 });
    const ac = new AbortController();
    const cancelled = budget.acquire('start', { projectId: 'b' }, { memoryMB: 512, signal: ac.signal });
    const rejection = expect(cancelled).rejects.toThrow('取消');
    expect((budget.snapshot().start as { queued: Array<{ reason: string }> }).queued[0].reason).toBe('memory-headroom');
    ac.abort(); await rejection;
    memory = 1200;
    const waiting = budget.acquire('start', { projectId: 'c' }, { memoryMB: 512 });
    first(); budget.pump();
    expect((budget.snapshot().start as { active: unknown[] }).active).toHaveLength(0);
    memory = 2000; budget.pump();
    const release = await waiting; release();
  });

  it('等待期间资格失效时不启动，也不占后继槽位', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, { pull: 1, start: 1, ready: 1, cleanup: 1 });
    const active = await budget.acquire('pull', {});
    let valid = true, ran = false;
    const obsolete = budget.run('pull', { projectId: 'a' }, async () => { ran = true; },
      { check: () => { if (!valid) throw new Error('superseded'); } });
    const rejected = expect(obsolete).rejects.toThrow('superseded');
    valid = false; active(); await rejected;
    expect(ran).toBe(false);
    await expect(budget.run('pull', { projectId: 'b' }, async () => true)).resolves.toBe(true);
  });

  it('Docker创建返回后启动槽归还，未就绪内存预留仍保留到就绪或真实回收', async () => {
    const budget = new DeploymentPhaseBudget(() => 2000);
    const release = await budget.acquire('start', { projectId: 'a' }, { memoryMB: 600, reservationKey: 'warming' });
    release();
    expect((budget.snapshot().start as { active: unknown[] }).active).toHaveLength(0);
    expect(budget.memorySnapshot()).toHaveLength(1);
    const next = budget.acquire('start', { projectId: 'b' }, { memoryMB: 600, reservationKey: 'next' });
    expect((budget.snapshot().start as { queued: unknown[] }).queued).toHaveLength(1);
    budget.releaseMemory('warming');
    const released = await next; released(); budget.releaseMemory('next');
    expect(budget.memorySnapshot()).toEqual([]);
  });

  it('PID余量不足时保持等待，启动回执不能提前归还线程预留', async () => {
    let pids = 96;
    const budget = new DeploymentPhaseBudget(() => 10000, {}, 1024, () => pids);
    const first = await budget.acquire('start', { projectId: 'a' }, { reservationKey: 'warming' });
    first();
    const next = budget.acquire('start', { projectId: 'b' }, { reservationKey: 'next' });
    expect((budget.snapshot().start as { queued: Array<{ reason: string }> }).queued[0].reason).toBe('pid-headroom');
    expect(budget.memorySnapshot()[0].pids).toBe(64);
    pids = 192; budget.pump(); const release = await next; release();
    budget.releaseMemory('warming'); budget.releaseMemory('next');
  });
});


describe('重启后的部署内存预留', () => {
  const id = 'a'.repeat(64);
  function fixture(status: string, receipt: Record<string, unknown> = {}) {
    const branch = { id: 'branch', projectId: 'project', services: { web: {
      profileId: 'web', containerName: 'old-web', containerId: id, creationIssued: true,
      hostPort: 10001, status: 'error',
    } } } as unknown as BranchEntry;
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker inspect/, () => ({ stdout: JSON.stringify({ id, status, project: 'project', branch: 'branch', profile: 'web', ...receipt }), stderr: '', exitCode: 0 }));
    const budget = new DeploymentPhaseBudget(() => 2000);
    return { branch, shell, budget };
  }

  it.each(['exited', 'dead'])('已核实停止的旧容器 %s 不恢复预留，新的项目能够启动', async status => {
    const f = fixture(status);
    await restoreDeploymentMemoryReservations([f.branch], () => [], { shell: f.shell, budget: f.budget });
    expect(f.budget.memorySnapshot()).toEqual([]);
    const release = await f.budget.acquire('start', { projectId: 'new-project' }, { memoryMB: 600, reservationKey: 'new-web' });
    release(); f.budget.releaseMemory('new-web');
    expect(f.shell.commands).toHaveLength(1);
    expect(f.shell.commands[0]).toMatch(/^docker inspect /);
    expect(f.branch.services.web.status).toBe('error');
  });

  it.each(['running', 'created', 'restarting'])('未完成的 %s 容器仍保留启动余量', async status => {
    const f = fixture(status);
    await restoreDeploymentMemoryReservations([f.branch], () => [], { shell: f.shell, budget: f.budget });
    expect(f.budget.memorySnapshot()).toHaveLength(1);
  });

  it.each([{ id: 'b'.repeat(64) }, { project: 'other' }, { branch: 'other' }, { profile: 'other' }])('停止证据身份不一致时保持预留 %j', async receipt => {
    const f = fixture('exited', receipt);
    await restoreDeploymentMemoryReservations([f.branch], () => [], { shell: f.shell, budget: f.budget });
    expect(f.budget.memorySnapshot()).toHaveLength(1);
  });

  it('无法读取 Docker 时保持未知运行的预留，不执行清理', async () => {
    const f = fixture('exited');
    f.shell.addResponsePatternFirst(/docker inspect/, () => ({ stdout: '', stderr: 'daemon unavailable', exitCode: 1 }));
    await restoreDeploymentMemoryReservations([f.branch], () => [], { shell: f.shell, budget: f.budget });
    expect(f.budget.memorySnapshot()).toHaveLength(1);
    expect(f.shell.commands.every(command => command.startsWith('docker inspect '))).toBe(true);
  });
});


const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'op-old', operationGeneration: 1 };
const idlePressure = (): BuildLoadPressure => ({ load1: 0, cores: 18, ratio: 0, factor: 1.2, saturated: false });

describe('启动期CPU占位与物理责任分离', () => {
  it('有效的三份新启动阻塞第四份，失效资格只退出CPU且不泄露检查函数', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, {}, 1024, () => 256, idlePressure);
    const valid = [true, true, true];
    for (let index = 0; index < 3; index++) {
      const release = await budget.acquire('start', { ...owner, operationId: `op-${index}` }, {
        reservationKey: `warm-${index}`, check: () => { if (!valid[index]) throw new Error('资格失效'); } });
      release();
    }
    const before = budget.memorySnapshot();
    expect(before.every(item => Object.keys(item).sort().join(',') === 'key,memoryMB,owner,pids')).toBe(true);
    expect(budget.snapshot().start.active).toEqual([]);
    let admitted = false;
    const abort = new AbortController();
    const next = budget.acquire('start', { ...owner, operationId: 'next' }, { reservationKey: 'next', signal: abort.signal })
      .then(release => { admitted = true; return release; }, () => undefined);
    try {
      await Promise.resolve(); expect(admitted).toBe(false);
      expect(budget.snapshot().start.queued[0].reason).toBe('cpu-startup-capacity');
      valid[0] = false; budget.pump(); await Promise.resolve();
      expect(admitted).toBe(true);
      expect(budget.memorySnapshot().filter(item => item.key.startsWith('warm-'))).toEqual(before);
    } finally { abort.abort(); (await next)?.(); for (const item of budget.memorySnapshot()) budget.releaseMemory(item.key); }
  });

  it.each(['memory-headroom', 'pid-headroom'] as const)('失效启动资格仍保留%s的原始物理保护', async reason => {
    let memory = reason === 'memory-headroom' ? 2000 : 10000;
    let pids = reason === 'pid-headroom' ? 96 : 256;
    let current = true;
    const budget = new DeploymentPhaseBudget(() => memory, {}, 1024, () => pids, idlePressure);
    const release = await budget.acquire('start', owner, { reservationKey: 'obsolete',
      check: () => { if (!current) throw new Error('资格失效'); } });
    release(); current = false;
    const before = budget.memorySnapshot();
    const abort = new AbortController(); let admitted = false;
    const next = budget.acquire('start', { ...owner, operationId: 'next' }, { reservationKey: 'next', signal: abort.signal })
      .then(released => { admitted = true; return released; }, () => undefined);
    try {
      await Promise.resolve(); expect(admitted).toBe(false);
      expect(budget.snapshot().start.queued[0].reason).toBe(reason);
      expect(budget.memorySnapshot()).toEqual(before);
      memory = 10000; pids = 256; budget.pump(); await Promise.resolve();
      expect(admitted).toBe(true);
      expect(budget.memorySnapshot().find(item => item.key === 'obsolete')).toEqual(before[0]);
    } finally { abort.abort(); (await next)?.(); for (const item of budget.memorySnapshot()) budget.releaseMemory(item.key); }
  });
});

describe('原阶段迟到结果保护', () => {
  it('实际阶段任务await结束后资格已失效时不能发布迟到结果', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, {}, 1024, () => Infinity, idlePressure);
    let entered!: () => void, finish!: () => void, current = true;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    const task = budget.run('ready', owner, async () => { entered(); await response; return true; },
      { check: () => { if (!current) throw new Error('superseded'); } });
    const rejected = expect(task).rejects.toThrow('superseded');
    await started; current = false; finish(); await rejected;
    expect(budget.snapshot().ready.active).toEqual([]);
  });
});
