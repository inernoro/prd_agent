import { afterEach, describe, expect, it, vi } from 'vitest';
import cp from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ShellExecutor } from '../../src/services/shell-executor.js';

const executors: ShellExecutor[] = [];
function executor(options?: { maxConcurrent?: number; maxQueued?: number }) {
  const value = new ShellExecutor(options);
  executors.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(executors.splice(0).map(value => value.close?.()));
});

describe('P2-01/P2-02: real execution outside the control thread', () => {
  it('does not create command processes in Master after warmup', async () => {
    const shell = executor();
    expect((await shell.exec('printf warmup')).exitCode).toBe(0);
    const calls = ['exec', 'execFile', 'spawn', 'fork'].map(key =>
      vi.spyOn(cp, key as 'exec'),
    );
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      shell.exec('printf isolated', { timeout: 2000 }),
    ));
    expect(results.every(result => result.exitCode === 0 && result.stdout === 'isolated')).toBe(true);
    expect(calls.map(call => call.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });

  it('preserves stdin, per-call env and both streams', async () => {
    const shell = executor();
    const chunks: string[] = [];
    const result = await shell.exec('cat; printf "$CDS_TEST_VALUE"; printf diagnostic >&2', {
      stdin: 'secret-via-stdin\n', env: { CDS_TEST_VALUE: 'call-env' },
      onData: chunk => chunks.push(chunk), timeout: 2000,
    });
    expect(result).toEqual({ stdout: 'secret-via-stdin\ncall-env', stderr: 'diagnostic', exitCode: 0 });
    expect(chunks.join('')).toContain('secret-via-stdin');
    expect(chunks.join('')).toContain('diagnostic');
  });

  it('bounds streamed IPC while Master withholds output acknowledgement, then resumes without losing bytes', async () => {
    const originalPost = Worker.prototype.postMessage;
    const withheld: Array<{ worker: Worker; message: any }> = []; let hold = true; let bytes = 0;
    let started!: () => void; const firstData = new Promise<void>(resolve => { started = resolve; });
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function(this: Worker, message: any, ...rest: any[]) {
      if (hold && message.type === 'ack') { withheld.push({ worker: this, message }); return; }
      return (originalPost as any).call(this, message, ...rest);
    });
    const shell = executor();
    const running = shell.exec(`"${process.execPath}" -e "process.stdout.write('x'.repeat(1024 * 1024))"`, {
      timeout: 5000, onData: chunk => { bytes += Buffer.byteLength(chunk); started(); },
    });
    try {
      await firstData; await new Promise(resolve => setTimeout(resolve, 100));
      expect(bytes).toBeLessThanOrEqual(320 * 1024);
      expect(withheld.length).toBeGreaterThan(0);
    } finally {
      hold = false;
      for (const item of withheld) originalPost.call(item.worker, item.message);
      post.mockRestore();
      const result = await running;
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(1024 * 1024);
      expect(bytes).toBe(1024 * 1024);
    }
  });

  it('honors an aborted queued command without executing it', async () => {
    const shell = executor({ maxConcurrent: 1 });
    const active = shell.exec('sleep 0.2; printf first', { timeout: 2000 });
    const abort = new AbortController();
    const queued = shell.exec('printf must-not-run', { signal: abort.signal, timeout: 2000 });
    abort.abort();
    expect(await queued).toEqual({ stdout: '', stderr: 'Command cancelled', exitCode: 130 });
    expect((await active).stdout).toBe('first');
  });

  it('rejects overflow while retaining accepted work', async () => {
    const shell = executor({ maxConcurrent: 1, maxQueued: 1 });
    const first = shell.exec('sleep 0.2; printf first', { timeout: 2000 });
    const second = shell.exec('printf second', { timeout: 2000 });
    const overflow = await shell.exec('printf overflow', { timeout: 2000 });
    expect(overflow.exitCode).toBe(75);
    expect(overflow.stdout).toBe('');
    expect((await first).stdout).toBe('first');
    expect((await second).stdout).toBe('second');
  });

  it('includes capacity wait in the command deadline', async () => {
    const shell = executor({ maxConcurrent: 1 });
    const first = shell.exec('sleep 0.25', { timeout: 2000 });
    const queued = await shell.exec('printf expired', { timeout: 50 });
    expect(queued.exitCode).toBe(124);
    expect(queued.stdout).toBe('');
    await first;
  });

  it('cancels a running shell and its descendant without waiting for the sleep', async () => {
    const shell = executor();
    const abort = new AbortController();
    const started = Date.now();
    const running = shell.exec('printf started; sleep 10', { signal: abort.signal, timeout: 3000 });
    setTimeout(() => abort.abort(), 100);
    expect((await running).exitCode).toBe(130);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('settles active/queued work on close and rejects new work', async () => {
    const shell = executor({ maxConcurrent: 1 });
    const running = shell.exec('sleep 10', { timeout: 3000 });
    const queued = shell.exec('printf queued', { timeout: 3000 });
    await shell.close();
    expect((await running).exitCode).not.toBe(0);
    expect((await queued).exitCode).not.toBe(0);
    expect((await shell.exec('printf after-close')).exitCode).not.toBe(0);
  });

  it('reserves capacity so health checks can finish ahead of long background commands', async () => {
    const shell = executor({ maxConcurrent: 3 });
    await shell.exec('printf warmup');
    const order: string[] = [];
    const background = Array.from({ length: 3 }, () => shell.exec('sleep 0.3; printf background', { timeout: 2000 }).then(() => order.push('background')));
    await shell.exec('printf health', { priority: 'health', timeout: 2000 });
    order.push('health');
    expect(order[0]).toBe('health');
    await Promise.all(background);
  });

  it('keeps a delivery slot available when long diagnostic log commands are queued', async () => {
    const shell = executor({ maxConcurrent: 3 }); const order: string[] = [];
    const logs = Array.from({ length: 2 }, () => shell.exec('sleep 0.2', { priority: 'diagnostic', timeout: 2000 }).then(() => order.push('log')));
    await shell.exec('printf delivery', { priority: 'delivery', timeout: 2000 }); order.push('delivery');
    expect(order[0]).toBe('delivery'); await Promise.all(logs);
  });

  it('rotates queued project groups while preserving order within each group', async () => {
    const shell = executor({ maxConcurrent: 1 });
    const order: string[] = [];
    const first = shell.exec('sleep 0.1', { schedulingGroup: 'a', timeout: 2000 });
    const pending = [['a', 'a1'], ['a', 'a2'], ['b', 'b1']].map(([group, label]) =>
      shell.exec(`printf ${label}`, { schedulingGroup: group, timeout: 2000 }).then(() => order.push(label)));
    await first;
    await Promise.all(pending);
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a2'));
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'));
  });

  it('keeps the queue bounded even when normal commands cannot use the health reserve', async () => {
    const shell = executor({ maxConcurrent: 3, maxQueued: 1 });
    const first = shell.exec('sleep 0.2', { timeout: 2000 });
    const second = shell.exec('sleep 0.2', { timeout: 2000 });
    const queued = shell.exec('printf queued', { timeout: 2000 });
    const overflow = await shell.exec('printf must-not-run', { timeout: 2000 });
    expect(overflow.exitCode).toBe(75);
    await Promise.all([first, second, queued]);
  });
  it('rotates three project groups instead of alternating the first two until exhaustion', async () => {
    const shell = executor({ maxConcurrent: 1 }); const order: string[] = [];
    const first = shell.exec('sleep 0.1', { schedulingGroup: 'a', timeout: 2000 });
    const pending = ['a1', 'a2', 'b1', 'b2', 'c1'].map(label => shell.exec(`printf ${label}`, {
      schedulingGroup: label[0], timeout: 2000,
    }).then(() => order.push(label)));
    await first; await Promise.all(pending);
    expect(order.indexOf('c1')).toBeLessThan(order.indexOf('a2'));
    expect(order.indexOf('c1')).toBeLessThan(order.indexOf('b2'));
  });

  it('contains dispatch errors within ExecResult and does not strand accepted work', async () => {
    const shell = executor({ maxConcurrent: 1 });
    const invalid = await shell.exec('printf invalid', { stdin: (() => {}) as unknown as string, timeout: 100 });
    expect(invalid.exitCode).toBe(1);
    expect((await shell.exec('printf recovered', { timeout: 2000 })).stdout).toBe('recovered');
  });

  it('reaps a real child after a hard worker crash before Master receives its PID', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cds-shell-hardcrash-'));
    const pidFile = path.join(directory, 'pid'); let pid = 0;
    const originalEmit = Worker.prototype.emit;
    const emit = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: any[]) {
      if (event === 'message' && args[0]?.type === 'pid') return true;
      return originalEmit.call(this, event, ...args);
    });
    try {
      const shell = executor();
      const running = shell.exec('printf %s "$$" > "$CDS_CRASH_PIDFILE"; exec sleep 10', {
        timeout: 5000, env: { CDS_CRASH_PIDFILE: pidFile },
      });
      for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      }
      expect(pid).toBeGreaterThan(0);
      expect([...((shell as any).active.values())][0].pid).toBeUndefined();
      await (shell as any).worker.terminate();
      expect((await running).exitCode).toBe(1);
      const state = cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      expect(state === '' || state.startsWith('Z')).toBe(true);
      emit.mockRestore();
      expect((await shell.exec('printf recovered', { timeout: 2000 })).stdout).toBe('recovered');
    } finally {
      emit.mockRestore();
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes the worker after it cleans commands dispatched before their PID arrived', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cds-shell-close-'));
    const pidFile = path.join(directory, 'pid');
    let pid = 0;
    try {
      const shell = executor();
      await shell.exec('printf warmup');
      const running = shell.exec('printf %s "$$" > "$CDS_CLOSE_PIDFILE"; exec sleep 10', {
        timeout: 2000, env: { CDS_CLOSE_PIDFILE: pidFile },
      });
      await shell.close();
      expect((await running).exitCode).toBe(130);
      await new Promise(resolve => setTimeout(resolve, 100));
      pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      if (pid) {
        const state = cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        expect(state === '' || state.startsWith('Z')).toBe(true);
      }
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reaps TERM-resistant descendants even when the parent shell closes its pipes first', async () => {
    const shell = executor();
    const directory = await mkdtemp(path.join(tmpdir(), 'cds-shell-cancel-'));
    const pidFile = path.join(directory, 'pid');
    const abort = new AbortController();
    let pid = 0;
    try {
      const running = shell.exec(
        `sh -c 'trap "" TERM; printf %s "$$" > "$CDS_CANCEL_PIDFILE"; exec sleep 10' >/dev/null 2>&1 & wait`,
        { signal: abort.signal, timeout: 3000, env: { CDS_CANCEL_PIDFILE: pidFile } },
      );
      for (let i = 0; i < 100 && !pid; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      }
      expect(pid).toBeGreaterThan(0);
      abort.abort();
      expect((await running).exitCode).toBe(130);
      await new Promise(resolve => setTimeout(resolve, 500));
      const state = cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      expect(state === '' || state.startsWith('Z')).toBe(true);
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      abort.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
