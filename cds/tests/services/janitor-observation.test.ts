import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as childProcess from 'node:child_process';
import * as janitorModule from '../../src/services/janitor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import type { StateService } from '../../src/services/state.js';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), exec: vi.fn(actual.exec), spawn: vi.fn(actual.spawn) };
});
const dirs: string[] = [];
const executors: IsolatedShellExecutor[] = [];
const initialEnv = Object.fromEntries(['PATH', 'CDS_JANITOR_QUERY_FAILURE', 'CDS_JANITOR_CONFLICT', 'CDS_JANITOR_INSPECT'].map(key => [key, process.env[key]]));
interface Trace { args: string[]; ppid: number; }
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-janitor-read-'));
  dirs.push(dir);
  const traceFile = path.join(dir, 'trace.jsonl');
  const image = 'cds-fixture-api:sha-' + 'a'.repeat(40);
  const script = `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({args,ppid:process.ppid})+'\\n');
if ((args[0]==='ps'||args[0]==='images') && process.env.CDS_JANITOR_QUERY_FAILURE===args[0]) {
 process.stderr.write('fixture-query-unavailable');process.exitCode=1;
} else if(args[0]==='images')console.log(${JSON.stringify(image)});
else if(args[0]==='ps') {
 if(args.includes('-aq'))console.log('111a\\n222b');
 else if(!args.includes('--filter'))console.log(${JSON.stringify(image)});
} else if(args[0]==='inspect') {
 if(process.env.CDS_JANITOR_INSPECT!=='empty')console.log('/owned/mounted');
 if(process.env.CDS_JANITOR_INSPECT)process.exitCode=1;
} else if(args[0]==='rmi'&&process.env.CDS_JANITOR_CONFLICT==='silent') {
 process.exitCode=1;
} else if(args[0]==='rmi'&&process.env.CDS_JANITOR_CONFLICT&&!args.includes('-f')) {
 process.stderr.write('conflict: must be forced');process.exitCode=1;
} else console.log('Total reclaimed space: fixture');
`;
  await writeFile(path.join(dir, 'docker'), script, { mode: 0o700 });
  process.env.PATH = `${dir}:${initialEnv.PATH || ''}`;
  const operation = { exec: vi.fn((...args: Parameters<ShellExecutor['exec']>) => new ShellExecutor().exec(...args)) };
  const shell = new IsolatedShellExecutor(operation);
  executors.push(shell);
  await shell.start();
  const adapters = process.env.CDS_JANITOR_REFERENCE === '1'
    ? { imageDocker: janitorModule.defaultImageDocker, orphanWorktreeFs: janitorModule.defaultOrphanWorktreeFs, dockerPrune: janitorModule.defaultDockerPrune }
    : janitorModule.createJanitorDockerAdapters(shell);
  const trace = async (): Promise<Trace[]> => (await readFile(traceFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, image, shell, operation, adapters, trace };
}
afterEach(async () => {
  await Promise.all(executors.splice(0).map(e => e.close()));
  for (const [key, value] of Object.entries(initialEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe('Janitor 真实命令与观测隔离', () => {
  it('实际巡检读取不由 Master 创建进程，Go 模板和批量参数保持原样', async () => {
    const f = await fixture();
    vi.clearAllMocks();
    const [images, inUse, mounts] = await Promise.all([
      f.adapters.imageDocker.listImages(), f.adapters.imageDocker.listInUseImages(), f.adapters.orphanWorktreeFs.listMountedHostPaths(),
    ]);
    expect(images).toEqual([f.image]); expect(inUse).toEqual([f.image]); expect(mounts).toEqual(['/owned/mounted']);
    const trace = await f.trace();
    // 原默认 execFile 路径中，真实 fixture 进程以 Master 为父进程，此断言失败。
    expect(trace.every(item => item.ppid !== process.pid)).toBe(true);
    expect(trace.find(item => item.args[0] === 'inspect')?.args).toEqual(['inspect', '--format', '{{range .Mounts}}{{println .Source}}{{end}}', '111a', '222b']);
    expect(f.operation.exec).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled(); expect(childProcess.exec).not.toHaveBeenCalled(); expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('容器占用查询失败使实际 sweep 停止镜像回收，不把 unknown 当成空集合', async () => {
    const f = await fixture();
    process.env.CDS_JANITOR_QUERY_FAILURE = 'ps';
    await expect(f.adapters.imageDocker.listInUseImages()).rejects.toThrow();
    const state = { getAllBranches: () => [], getDeploymentVersions: () => [] } as unknown as StateService;
    const sweep = new janitorModule.JanitorService(state,
      { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600, dockerPrune: false, orphanWorktrees: false },
      f.dir, undefined, () => null, f.adapters.dockerPrune, f.adapters.imageDocker, f.adapters.orphanWorktreeFs);
    const result = await sweep.runSweep();
    expect(result.errors.some(error => error.includes('image retention'))).toBe(true);
    expect((await f.trace()).some(item => item.args[0] === 'rmi')).toBe(false);
    process.env.CDS_JANITOR_QUERY_FAILURE = 'images';
    await expect(f.adapters.imageDocker.listImages()).rejects.toThrow();
  });

  it('强删前引用未知时保留镜像，恶意样式参数仍只是一个真实 argv', async () => {
    const f = await fixture();
    process.env.CDS_JANITOR_CONFLICT = '1';
    process.env.CDS_JANITOR_QUERY_FAILURE = 'ps';
    const sentinel = path.join(f.dir, 'must-not-execute');
    const image = `img:tag'; touch ${sentinel}; '`;
    const result = await f.adapters.imageDocker.removeImage(image);
    expect(result?.startsWith(janitorModule.IMAGE_HELD_PREFIX)).toBe(true);
    const trace = await f.trace();
    expect(trace.find(item => item.args[0] === 'rmi')?.args).toEqual(['rmi', image]);
    expect(trace.find(item => item.args[0] === 'ps')?.args).toContain(`ancestor=${image}`);
    expect(trace.filter(item => item.args[0] === 'rmi')).toHaveLength(1);
    expect(f.operation.exec.mock.calls.every(([, options]) => options?.executionLane === 'operation')).toBe(true);
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('inspect 的部分输出保留已知挂载，查询失败且无输出则返回未知', async () => {
    const f = await fixture();
    process.env.CDS_JANITOR_INSPECT = 'partial';
    expect(await f.adapters.orphanWorktreeFs.listMountedHostPaths()).toEqual(['/owned/mounted']);
    process.env.CDS_JANITOR_INSPECT = 'empty';
    expect(await f.adapters.orphanWorktreeFs.listMountedHostPaths()).toBeNull();
    process.env.CDS_JANITOR_QUERY_FAILURE = 'ps';
    expect(await f.adapters.orphanWorktreeFs.listMountedHostPaths()).toBeNull();
    await f.shell.close();
    expect(await f.adapters.orphanWorktreeFs.listMountedHostPaths()).toBeNull();
    await expect(f.adapters.imageDocker.listImages()).rejects.toMatchObject({ code: 'closed' });
  });

  it('删除非零退出但无错误输出时也不能报告成功', async () => {
    const f = await fixture();
    process.env.CDS_JANITOR_CONFLICT = 'silent';
    expect(await f.adapters.imageDocker.removeImage(f.image)).toBeTruthy();
    expect((await f.trace()).filter(item => item.args[0] === 'rmi')).toHaveLength(1);
  });
});
