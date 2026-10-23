import { describe, expect, it, vi } from 'vitest';
import { DeploymentPhaseBudget, restoreDeploymentMemoryReservations } from '../../src/services/deployment-phase-budget.js';

import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry } from '../../src/types.js';

describe('部署阶段容量准入', () => {
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
    expect(order).toEqual(['b2', 'a0', 'c3', 'a1']);
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

  it('仅实际有界且原代 scope 仍有效的等待可用作心跳收割证据', async () => {
    let now = 1000, current = true;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const budget = new DeploymentPhaseBudget(() => 0), controller = new AbortController();
    const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'owned-op', operationGeneration: 2 };
    const waiting = budget.acquire('start', owner, { signal: controller.signal,
      check: () => { if (!current) throw new Error('本代已失效'); } }).catch(() => undefined);
    try {
      expect(budget.waitingOperation('owned-op', 2, owner)).toMatchObject({ phase: 'start', enqueuedAt: 1000, deadlineAt: 1_201_000 });
      expect(budget.waitingOperation('owned-op', 2, { projectId: 'p1', branchId: 'b1' })).toBeDefined();
      expect(budget.waitingOperation('owned-op', 1, owner)).toBeUndefined();
      for (const scope of [{ ...owner, projectId: 'p2' }, { ...owner, branchId: 'b2' }, { ...owner, profileId: 'web' }]) {
        expect(budget.waitingOperation('owned-op', 2, scope)).toBeUndefined();
      }
      now += 16 * 60_000;
      expect(budget.waitingOperation('owned-op', 2, owner)).toBeDefined();
      current = false;
      expect(budget.waitingOperation('owned-op', 2, owner)).toBeUndefined();
      current = true; now += 5 * 60_000;
      expect(budget.waitingOperation('owned-op', 2, owner)).toBeUndefined();
    } finally { controller.abort(); await waiting; time.mockRestore(); }
  });

  it('没有原资格 check 的陈旧调用不产生等待证明，执行中也不是等待', async () => {
    const budget = new DeploymentPhaseBudget(() => 0), controller = new AbortController();
    const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'owned-op', operationGeneration: 2 };
    const waiting = budget.acquire('start', owner, { signal: controller.signal }).catch(() => undefined);
    try { expect(budget.waitingOperation('owned-op', 2, owner)).toBeUndefined(); }
    finally { controller.abort(); await waiting; }
    const release = await budget.acquire('pull', owner, { check: () => {} });
    try { expect(budget.waitingOperation('owned-op', 2, owner)).toBeUndefined(); }
    finally { release(); }
  });

  it('阶段 task 异步返回后仍须核对资格，迟到成功不能被继续使用', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000);
    let current = true;
    await expect(budget.run('pull', {}, async () => { current = false; return 'late-result'; },
      { check: () => { if (!current) throw new Error('本代已失效'); } })).rejects.toThrow('本代已失效');
    expect((budget.snapshot().pull as { active: unknown[] }).active).toEqual([]);
  });

  it('历史默认项目省略 projectId 的真实队列仍归属 default，不借给其他项目', async () => {
    const budget = new DeploymentPhaseBudget(() => 0), controller = new AbortController();
    const waiting = budget.acquire('start', { branchId: 'b1', profileId: 'api', operationId: 'owned-op', operationGeneration: 2 },
      { check: () => {}, signal: controller.signal }).catch(() => undefined);
    try {
      expect(budget.waitingOperation('owned-op', 2, { projectId: 'default', branchId: 'b1', profileId: 'api' })).toBeDefined();
      expect(budget.waitingOperation('owned-op', 2, { projectId: 'p2', branchId: 'b1', profileId: 'api' })).toBeUndefined();
    } finally { controller.abort(); await waiting; }
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

  it('acquire await 恢复前已有同字段后继预约，原 owner 不能捕获其退款许可', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000);
    const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'op', operationGeneration: 1 };
    const admitted = budget.acquire('start', owner, { reservationKey: 'owned', memoryMB: 512 });
    const successor = { ...owner };
    budget.reserveKnownMemory('owned', 600, successor, 128);
    const release = await admitted;
    expect(budget.captureMemoryRelease('owned', owner)()).toBe(false);
    expect(budget.memorySnapshot()[0]).toMatchObject({ memoryMB: 600, pids: 128 });
    expect(budget.memorySnapshot()[0].owner).toBe(successor);
    release(); budget.releaseMemory('owned');
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

  it('聚合 building 不重复预约同一已发布 CID，新 pending 候选仍保留预约', async () => {
    const f = fixture('running'), service = f.branch.services.web;
    service.status = 'building';
    service.servingRuntime = { containerName: service.containerName, containerId: id, creationIssued: true, hostPort: service.hostPort };
    await restoreDeploymentMemoryReservations([f.branch], () => [], { shell: f.shell, budget: f.budget });
    expect(f.budget.memorySnapshot()).toEqual([]);
    service.pendingRuntime = { containerName: 'new-web', creationIssued: true, hostPort: 10002 };
    await restoreDeploymentMemoryReservations([f.branch], () => [], { shell: f.shell, budget: f.budget });
    expect(f.budget.memorySnapshot()).toEqual([expect.objectContaining({ key: 'new-web', owner: {
      projectId: 'project', branchId: 'branch', profileId: 'web',
    } })]);
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
