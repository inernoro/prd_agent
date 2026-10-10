import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerDiagnosticBudget } from '../../src/services/container-diagnostic-budget.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const id = (n: number) => n.toString(16).padStart(64, '0');
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('bounded container diagnostics', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps different run, owner scope and recreated container identities separate', async () => {
    const collect = vi.fn(async () => ({ inspect: { state: { status: 'exited' } } }));
    const budget = new ContainerDiagnosticBudget(collect);
    await Promise.all([budget.collectFor(id(1), 'run1/branch1'), budget.collectFor(id(1), 'run2/branch1'),
      budget.collectFor(id(1), 'run1/branch2'), budget.collectFor(id(2), 'run1/branch1')]);
    expect(collect).toHaveBeenCalledTimes(4);
  });

  it('expires cache five seconds after completion, not after a slow collection starts', async () => {
    let now = 0;
    const gate = deferred<{ inspect: { marker: number } }>();
    const collect = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({ inspect: { marker: 2 } });
    const budget = new ContainerDiagnosticBudget(collect, () => now);
    const first = budget.collectFor(id(1), 'run');
    now = 10000;
    gate.resolve({ inspect: { marker: 1 } });
    await first;
    now = 14999;
    expect(await budget.collectFor(id(1), 'run')).toEqual({ inspect: { marker: 1 } });
    now = 15000;
    expect(await budget.collectFor(id(1), 'run')).toEqual({ inspect: { marker: 2 } });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('does not recache an old in-flight snapshot after start/restart invalidation', async () => {
    const gate = deferred<any>();
    const collect = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({ inspect: { epoch: 2 } });
    const budget = new ContainerDiagnosticBudget(collect);
    const old = budget.collectFor(id(1), 'run');
    budget.invalidate(id(1));
    const fresh = budget.collectFor(id(1), 'run');
    gate.resolve({ inspect: { epoch: 1 } });
    await old;
    expect(await fresh).toEqual({ inspect: { epoch: 2 } });
    expect(await budget.collectFor(id(1), 'run')).toEqual({ inspect: { epoch: 2 } });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('allows one active and sixteen queued jobs, including uncached legacy references', async () => {
    const gate = deferred<any>();
    const collect = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({});
    const budget = new ContainerDiagnosticBudget(collect);
    const jobs = Array.from({ length: 17 }, (_, i) => budget.collectFor(`legacy-${i}`, 'run'));
    expect(await budget.collectFor(id(99), 'run')).toEqual({ error: { message: 'diagnostic_capacity' } });
    await settle();
    expect(collect).toHaveBeenCalledTimes(1);
    gate.resolve({});
    await Promise.all(jobs);
    expect(collect).toHaveBeenCalledTimes(17);
  });

  it('times out queued diagnostics without spawning them or blocking fresh work', async () => {
    vi.useFakeTimers();
    const gate = deferred<any>();
    const collect = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({});
    const budget = new ContainerDiagnosticBudget(collect);
    const active = budget.collectFor(id(1), 'run');
    const queued = budget.collectFor(id(2), 'run');
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await queued).toEqual({ error: { message: 'diagnostic_queue_timeout' } });
    expect(collect).toHaveBeenCalledTimes(1);
    gate.resolve({});
    await active;
    await settle();
    await budget.collectFor(id(3), 'run');
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('bounds completed entries to sixty-four and evicts the oldest completion', async () => {
    const collect = vi.fn(async () => ({}));
    const budget = new ContainerDiagnosticBudget(collect, () => 0);
    for (let i = 1; i <= 65; i++) await budget.collectFor(id(i), 'run');
    await budget.collectFor(id(65), 'run');
    expect(collect).toHaveBeenCalledTimes(65);
    await budget.collectFor(id(1), 'run');
    expect(collect).toHaveBeenCalledTimes(66);
  });

  it('does not cache mutable names and keeps rejected collection errors bounded', async () => {
    const collect = vi.fn().mockRejectedValueOnce(new Error('private-raw-command'))
      .mockResolvedValue({ inspect: { status: 'running' } });
    const budget = new ContainerDiagnosticBudget(collect);
    expect(await budget.collectFor('reused-name', 'run')).toEqual({ error: { message: 'diagnostic_collect_failed' } });
    expect(await budget.collectFor('reused-name', 'run')).toEqual({ inspect: { status: 'running' } });
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
