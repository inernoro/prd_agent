import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as childProcess from 'node:child_process';
import { ObservationStreamExecutor } from '../../src/services/observation-stream-executor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { ContainerService } from '../../src/services/container.js';
import { shellQuoteArg } from '../../src/services/secure-database-cli.js';
import type { CdsConfig } from '../../src/types.js';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn(actual.exec), spawn: vi.fn(actual.spawn) };
});
const pools: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];
const originalPath = process.env.PATH;
const command = (program: string): string => ['exec', process.execPath, '-e', program].map((x, i) => i ? shellQuoteArg(x) : x).join(' ');
async function streams(count = 1): Promise<ObservationStreamExecutor> {
  const pool = new ObservationStreamExecutor(count); pools.push(pool); await pool.start(); return pool;
}
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-startup-stream-')); dirs.push(dir); return dir;
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Stream fixture did not become ready');
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map(p => p.close()));
  await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true })));
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  vi.clearAllMocks();
});

describe('独立启动日志执行槽真实进程', () => {
  it('超过10MiB的实际输出不捕获全文，回调按序消费后才完成且不从Master创建', async () => {
    const pool = await streams(); vi.clearAllMocks();
    let prefix = ''; let received = 0;
    const result = await pool.exec(command("process.stdout.write(process.ppid+'\\n');process.stdout.write(Buffer.alloc(12*1024*1024,120));process.stdout.write('尾部𠮷');"), {
      timeout: 20_000, onData: async chunk => {
        if (!received) prefix = chunk;
        await new Promise(r => setTimeout(r, 1)); received += Buffer.byteLength(chunk);
      },
    });
    const parent = Number(prefix.split('\n')[0]);
    expect(parent).not.toBe(process.pid);
    expect(pool.getStats().actors.map(actor => actor.pid)).toContain(parent);
    expect(received).toBe(Buffer.byteLength(String(parent) + '\n尾部𠮷') + 12 * 1024 * 1024);
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(childProcess.spawn).not.toHaveBeenCalled(); expect(childProcess.exec).not.toHaveBeenCalled();
    expect(pool.getStats().admitted).toBe(0);
  }, 25_000);

  it('实际慢消费暂停上游，满流槽不启动新命令且不占健康查询槽', async () => {
    const dir = await directory(); const marker = path.join(dir, 'producer-finished');
    const sentinel = path.join(dir, 'must-not-start');
    const pool = await streams();
    const health = new IsolatedShellExecutor(new ShellExecutor(), { concurrency: 1 }); pools.push(health); await health.start();
    let release!: () => void; let entered = false; let received = 0; let completed = false;
    const gate = new Promise<void>(r => { release = r; });
    const program = `const {once}=require('node:events');(async()=>{for(let i=0;i<32;i++){if(!process.stdout.write(Buffer.alloc(65536,120)))await once(process.stdout,'drain');}require('node:fs').writeFileSync(${JSON.stringify(marker)},'done');})();`;
    const running = pool.exec(command(program), { timeout: 15_000, onData: async chunk => {
      if (!entered) { entered = true; await gate; } received += Buffer.byteLength(chunk);
    } }).then(result => { completed = true; return result; });
    try {
      await until(() => entered); await new Promise(r => setTimeout(r, 100));
      expect(completed).toBe(false); await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(pool.exec(`touch ${shellQuoteArg(sentinel)}`, { onData: () => {} })).rejects.toMatchObject({ code: 'capacity' });
      await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await health.exec('echo health-ready', { executionLane: 'observation', timeout: 1000 })).stdout.trim()).toBe('health-ready');
    } finally { release(); }
    expect((await running).exitCode).toBe(0); expect(received).toBe(2 * 1024 * 1024);
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it('实际取消清理子进程后释放流槽并可再次读取', async () => {
    const dir = await directory(); const pidFile = path.join(dir, 'owned-child.pid');
    const pool = await streams(); const ac = new AbortController();
    const running = pool.exec(`sleep 30 & echo $! > ${shellQuoteArg(pidFile)}; wait`, { signal: ac.signal, timeout: 5000, onData: () => {} });
    const rejected = expect(running).rejects.toMatchObject({ code: 'cancelled' });
    await until(() => pool.getStats().active === 1);
    for (let i = 0; i < 100; i++) { try { await access(pidFile); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    const pid = Number((await readFile(pidFile, 'utf8')).trim()); ac.abort(); await rejected;
    expect((await new ShellExecutor().exec(`ps -o stat= -p ${pid}`)).stdout.trim()).toMatch(/^(Z.*)?$/);
    let data = ''; expect((await pool.exec('echo next-read', { onData: chunk => { data += chunk; } })).exitCode).toBe(0);
    expect(data.trim()).toBe('next-read'); expect(pool.getStats().admitted).toBe(0);
  });

  it('实际启动信号跨块匹配，等待清理且生产注入不由Master启动docker', async () => {
    const dir = await directory(); const trace = path.join(dir, 'parent.json');
    await writeFile(path.join(dir, 'docker'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(trace)},JSON.stringify({ppid:process.ppid,args:process.argv.slice(2)}));process.stdout.write('startup-');setTimeout(()=>process.stdout.write('ready'),40);setInterval(()=>{},1000);\n`, { mode: 0o700 });
    process.env.PATH = `${dir}:${originalPath || ''}`;
    const pool = await streams(); vi.clearAllMocks();
    const container = new ContainerService(new ShellExecutor(), {} as CdsConfig, undefined, undefined, pool);
    expect(await container.waitForStartupSignal('owned-fixture', 'startup-ready', undefined, 2)).toBe(true);
    const view = JSON.parse(await readFile(trace, 'utf8'));
    expect(view.ppid).not.toBe(process.pid); expect(view.args).toEqual(['logs', '-f', 'owned-fixture']);
    expect(childProcess.spawn).not.toHaveBeenCalled(); expect(pool.getStats().admitted).toBe(0);
  });

  it('匹配后清理未确认不报告就绪', async () => {
    const failed = { exec: async (_command: string, options: { onData: (chunk: string) => void }) => {
      options.onData('ready'); throw Object.assign(new Error('fixture cleanup unknown'), { code: 'cleanup' });
    } } as unknown as ObservationStreamExecutor;
    const container = new ContainerService(new ShellExecutor(), {} as CdsConfig, undefined, undefined, failed);
    expect(await container.waitForStartupSignal('owned-fixture', 'ready')).toBe(false);
  });
});
