import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn(actual.exec), spawn: vi.fn(actual.spawn) };
});
const pools: IsolatedShellExecutor[] = [];
const dirs: string[] = [];
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string): string => `exec ${quote(process.execPath)} --eval ${quote(script)}`;
async function directory(): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), 'cds-operation-private-')); dirs.push(dir); return dir; }
function pool(config: ConstructorParameters<typeof IsolatedShellExecutor>[1] = {}): IsolatedShellExecutor {
  const e = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1, defaultTimeoutMs: 5000, ...config });
  pools.push(e); return e;
}
async function waitFor(test: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 500; n++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Own operation fixture did not become ready');
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map(p => p.close()));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  vi.mocked(childProcess.exec).mockClear(); vi.mocked(childProcess.spawn).mockClear();
});
describe('普通操作独立执行真实进程', () => {
  it('普通待办达到上限时，保留清理待办仍能执行且不增加总队列预算', async () => {
    const e = pool({ concurrency: 2, reservedCleanup: 1, maxQueued: 2 }); await e.start();
    const dir = await directory(); const ready = path.join(dir, 'ready'); const release = path.join(dir, 'release'); const cleaned = path.join(dir, 'cleaned');
    const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},10);`;
    const blocker = e.exec(node(script)); const pending: Array<Promise<unknown>> = [blocker.catch(error => error)];
    try {
      await waitFor(async () => { try { await access(ready); return true; } catch { return false; } });
      pending.push(e.exec('echo queued-owned', { beforeStart: () => {} }).catch(error => error));
      expect(e.getStats().queued).toBe(1);
      await expect(e.exec('echo rejected-extra', { beforeStart: () => {}, timeout: 100 })).rejects.toMatchObject({ code: 'capacity' });
      expect((await e.exec(`touch ${quote(cleaned)}`, { executionPurpose: 'temporary-cleanup' })).exitCode).toBe(0);
      await access(cleaned); expect(e.getStats().queued).toBe(1); expect(e.getStats().active).toBe(1);
    } finally { const { writeFile } = await import('node:fs/promises'); await writeFile(release, 'released'); await Promise.all(pending); }
    expect(e.getStats().bytes).toBe(0); expect(e.getStats().queued).toBe(0);
  });

  it('普通输入字节达到预算时，清理字节保留且收尾后精确释放原预算', async () => {
    const dir = await directory(); const ready = path.join(dir, 'ready'); const release = path.join(dir, 'release'); const cleaned = path.join(dir, 'cleaned');
    const command = node(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},10);`);
    const overhead = Buffer.byteLength(JSON.stringify({ env: { ...process.env }, stream: false, captureOutput: true }));
    const cleanupBytes = overhead + 1024; const normalBytes = overhead + Buffer.byteLength(command) + 512;
    const e = pool({ concurrency: 2, reservedCleanup: 1, maxQueued: 4, maxBytes: normalBytes + cleanupBytes, reservedCleanupBytes: cleanupBytes }); await e.start();
    const blocker = e.exec(command); const settled = blocker.catch(error => error);
    try {
      await waitFor(async () => { try { await access(ready); return true; } catch { return false; } });
      await expect(e.exec('echo ' + 'x'.repeat(1024), { beforeStart: () => {}, timeout: 100 })).rejects.toMatchObject({ code: 'capacity' });
      expect((await e.exec(`touch ${quote(cleaned)}`, { executionPurpose: 'temporary-cleanup' })).exitCode).toBe(0);
      await access(cleaned); expect(e.getStats().bytes).toBeLessThanOrEqual(normalBytes + cleanupBytes);
      await expect(e.exec('echo ' + 'x'.repeat(cleanupBytes), { executionPurpose: 'temporary-cleanup' })).rejects.toMatchObject({ code: 'capacity' });
    } finally { const { writeFile } = await import('node:fs/promises'); await writeFile(release, 'released'); await settled; }
    expect(e.getStats().bytes).toBe(0); expect(e.getStats().active).toBe(0);
    expect((await e.exec('echo budget-reused')).stdout.trim()).toBe('budget-reused');
  });

  it('普通操作实际占满时，保留清理槽仍执行私有回收而不放行更多普通操作', async () => {
    const e = pool({ concurrency: 2, reservedCleanup: 1 }); await e.start();
    const dir = await directory(); const release = path.join(dir, 'release'); const ready = path.join(dir, 'ready'); const cleaned = path.join(dir, 'cleaned');
    const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10);`;
    const blocker = e.exec(node(script)); const completed = blocker.catch(error => { throw error; });
    try {
      await waitFor(async () => { try { await access(ready); return true; } catch { return false; } });
      await expect(e.exec('echo must-not-use-reserved-slot')).rejects.toMatchObject({ code: 'capacity' });
      expect((await e.exec(`touch ${quote(cleaned)}`, { executionPurpose: 'temporary-cleanup' })).exitCode).toBe(0);
      await access(cleaned); expect(e.getStats().active).toBe(1); expect(e.getStats().activeCleanup).toBe(0);
    } finally { const { writeFile } = await import('node:fs/promises'); await writeFile(release, 'released'); await completed; }
  });
  it('默认操作不从Master创建命令，实际父进程属于预热actor', async () => {
    const e = pool(); await e.start();
    vi.mocked(childProcess.exec).mockClear(); vi.mocked(childProcess.spawn).mockClear();
    const r = await e.exec(node('console.log(process.ppid)'));
    const parent = Number(r.stdout.trim());
    expect(parent).not.toBe(process.pid);
    expect(e.getStats().actors.map(a => a.pid)).toContain(parent);
    expect(childProcess.exec).not.toHaveBeenCalled(); expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('排队期间旧目标失去资格，真正分配槽后拒绝原异常且不启动命令', async () => {
    const e = pool(); await e.start(); const initialActor = e.getStats().actors[0].pid;
    const dir = await directory(); const marker = path.join(dir, 'must-not-execute');
    const blocker = e.exec(node('setTimeout(()=>{},200)'));
    let current = true; const superseded = new Error('原部署已被新目标取代');
    const check = vi.fn(() => { if (!current) throw superseded; });
    const guarded = e.exec(`touch ${quote(marker)}`, { beforeStart: check });
    const outcome = guarded.then(() => ({ error: undefined }), error => ({ error }));
    current = false; await blocker;
    expect((await outcome).error).toBe(superseded);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(check).toHaveBeenCalledTimes(1);
    expect((await e.exec('echo next-owned-task')).stdout.trim()).toBe('next-owned-task');
    expect(e.getStats().actors[0].pid).toBe(initialActor);
  });

  it('保留stdin、工作目录、UTF8输出、环境覆盖及普通非零退出', async () => {
    const e = pool(); await e.start(); const dir = await directory(); const chunks: string[] = [];
    const script = "process.stdin.setEncoding('utf8');let value='';process.stdin.on('data',s=>value+=s);process.stdin.on('end',()=>{console.log(process.cwd());console.log(process.env.CDS_OWN_OPERATION_INPUT);console.log(value);console.error('自有诊断');process.exitCode=7;});";
    const r = await e.exec(node(script), { cwd: dir, stdin: '独立输入', env: { CDS_OWN_OPERATION_INPUT: '私有覆盖' }, onData: c => { chunks.push(c); } });
    expect(r.exitCode).toBe(7); expect(r.stdout).toContain(dir); expect(r.stdout).toContain('独立输入');
    expect(r.stdout).toContain('私有覆盖'); expect(r.stderr).toContain('自有诊断'); expect(chunks.join('')).toContain('独立输入');
    expect(e.getStats().active).toBe(0); expect(e.getStats().bytes).toBe(0);
  });

  it('排队过期或取消不检查资格也不启动；普通池满额不会占健康槽或回退Master', async () => {
    const operation = pool({ maxQueued: 2 }); const health = pool({ isolatedLane: 'observation' }); await Promise.all([operation.start(), health.start()]);
    const dir = await directory(); const marker = path.join(dir, 'queued-must-not-start');
    const blocker = operation.exec(node('setTimeout(()=>{},250)'));
    const check = vi.fn(); const ac = new AbortController();
    const expired = expect(operation.exec(`touch ${quote(marker)}`, { timeout: 40, beforeStart: check })).rejects.toMatchObject({ code: 'deadline', name: 'OperationExecutionError' });
    const cancelled = expect(operation.exec(`touch ${quote(marker)}`, { signal: ac.signal, beforeStart: check })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(operation.exec('echo must-not-fallback')).rejects.toMatchObject({ name: 'OperationExecutionError', code: 'capacity' });
    expect((await health.exec('echo health-preserved', { executionLane: 'observation' })).stdout.trim()).toBe('health-preserved');
    ac.abort(); await Promise.all([blocker, expired, cancelled]); expect(check).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('执行中取消等待真实后代进程清理，替换槽再核资格才启动下一任务', async () => {
    const e = pool(); await e.start(); const original = e.getStats().actors[0].pid;
    const dir = await directory(); const pidFile = path.join(dir, 'child.pid'); const ac = new AbortController();
    const cancelled = expect(e.exec(`sleep 30 & echo $! > ${quote(pidFile)}; wait`, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await waitFor(async () => { try { return !!(await readFile(pidFile, 'utf8')).trim(); } catch { return false; } });
    const pid = Number((await readFile(pidFile, 'utf8')).trim()); ac.abort(); await cancelled;
    const check = vi.fn(() => expect(e.getStats().actors.some(a => a.pid !== original && a.heapLimit)).toBe(true));
    expect((await e.exec('echo after-cleanup', { beforeStart: check })).stdout.trim()).toBe('after-cleanup');
    const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
    expect(state.stdout.trim()).toMatch(/^(Z.*)?$/); expect(check).toHaveBeenCalledTimes(1);
  });

  it('默认预算是有限操作预算，预热后截止替换也不会从Master创建命令', async () => {
    const e = pool({ defaultTimeoutMs: 100 }); await e.start(); const original = e.getStats().actors[0].pid;
    vi.mocked(childProcess.spawn).mockClear(); vi.mocked(childProcess.exec).mockClear();
    await expect(e.exec('sleep 30')).rejects.toMatchObject({ code: 'deadline', name: 'OperationExecutionError' });
    await waitFor(() => e.getStats().actors.some(a => a.pid !== original && !!a.heapLimit));
    expect((await e.exec('echo after-deadline', { timeout: 3000 })).stdout.trim()).toBe('after-deadline');
    expect(childProcess.exec).not.toHaveBeenCalled(); expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
