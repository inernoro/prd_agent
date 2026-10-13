import { describe, expect, it } from 'vitest';
import { DeploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';

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
