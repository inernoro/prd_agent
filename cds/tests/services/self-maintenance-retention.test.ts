import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import type { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { shellQuote } from '../../src/services/sidecar/sidecar-deployer.js';
import { confirmMaintenanceBoot, maintenanceDirectoryIdentity, retirementFor } from '../../src/services/self-maintenance-retention.js';
import type { ExecAssignment, ExecResult } from '../../src/types.js';

const directories = ['dist', 'web/dist', 'web/dist.previous', 'node_modules', 'web/node_modules'];
const compiledSource = (root: string, name: string) => pathToFileURL(path.join(root, '.owned/compiled/services', `${name}.js`)).href;
const roots: Array<{ root: string; mayRemove: boolean }> = [];
const pools: IsolatedShellExecutor[] = [];
const releases: string[] = [];
const executions: Promise<ExecResult>[] = [];
const gitEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'CDS retention fixture', GIT_AUTHOR_EMAIL: 'retention@example.test',
  GIT_COMMITTER_NAME: 'CDS retention fixture', GIT_COMMITTER_EMAIL: 'retention@example.test' };

interface Report {
  pid: number; ownerId: string; backupPath: string; sourceHead: string; branch: string;
  snapshot: { ownerId: string; existed: boolean[]; artifactsRestored: boolean };
  jobs: Array<{ action: string; assignment?: ExecAssignment; exitCode: number }>;
  afterRetainJobs: number; afterRollbackJobs: number; permitExitCode: number; permitSignal: string | null; closed: boolean;
  runtimeAfter: { activeJobCount: number; unconfirmedJobCount: number; restartScheduled: boolean };
  poolAfter: { active: number; queued: number };
}

function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cds-retention-')));
  const owned = { root, mayRemove: false }; roots.push(owned);
  fs.mkdirSync(path.join(root, 'cds/web'), { recursive: true });
  fs.mkdirSync(path.join(root, '.owned/tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'cds/dist/\ncds/web/dist/\ncds/web/dist.previous/\ncds/node_modules/\ncds/web/node_modules/\ncds/.cds/\n.owned/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'generation-A');
  // 原permit真实启动这个私有脚本；它不是原daemon/index/nginx，不冒称native验收。
  fs.writeFileSync(path.join(root, 'cds/exec_cds.sh'), '#!/bin/sh\n[ "$1" = daemon ] || exit 31\nprintf "%s\\n" "$1" >> .cds/permit-invocations\n');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args,
    { cwd: root, env: gitEnv, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet', '--initial-branch=before'); git('add', '.'); git('commit', '--quiet', '-m', '保留副本旧版夹具');
  const seed = (generation: string) => {
    for (const relative of directories) {
      const dir = path.join(root, 'cds', relative);
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'fixture'), `${generation}:${relative}`);
    }
  };
  seed('A');
  const modules = path.join(root, 'cds/node_modules');
  fs.mkdirSync(path.join(modules, '.pnpm/pkg/node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(modules, '.pnpm/pkg/node_modules/pkg/index.js'), 'owned-package');
  fs.symlinkSync('.pnpm/pkg/node_modules/pkg', path.join(modules, 'pkg'));
  fs.symlinkSync(path.join(modules, '.pnpm/pkg/node_modules/pkg'), path.join(modules, 'absolute-pkg'));
  fs.symlinkSync('.', path.join(modules, '.pnpm/pkg/node_modules/pkg/self'));
  return { root, owned, git, seed };
}

async function compileFixture(root: string) {
  // 复用既有runtime用例的逐文件ESM接缝；在本case原5000ms内构建，不预热或替换五目录。
  const source = fileURLToPath(new URL('../../src/', import.meta.url));
  const compiled = path.join(root, '.owned/compiled');
  const entries = [
    'services/self-maintenance-runtime.ts', 'services/self-maintenance-files-process.ts',
    'services/self-maintenance-retention.ts', 'services/self-update-handoff.ts',
    'services/atomic-directory-replacement.ts', 'services/isolated-shell-executor.ts',
    'services/observation-process-launcher.ts', 'services/observation-process-group.ts',
    'services/sidecar/sidecar-deployer.ts', 'services/sidecar/remote-host-service.ts',
    'services/docker-log-policy.ts',
    'services/ssh-exec-failure.ts', 'infra/secret-seal.ts',
    'services/shell-executor.ts', 'services/observation-process.ts',
    'services/observation-executor-process.ts', 'services/observation-supervisor-process.ts',
  ];
  await build({ entryPoints: entries.map(file => path.join(source, file)), outdir: compiled, outbase: source,
    format: 'esm', platform: 'node', target: 'node20', bundle: false, sourcemap: false, logLevel: 'silent' });
  fs.writeFileSync(path.join(compiled, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(fs.realpathSync(new URL('../../node_modules/', import.meta.url)), path.join(compiled, 'node_modules'), 'dir');
  // 外层监督链也用本例刚编译的真实ESM，避免为夹具额外启动TSX；构建/导入仍计入原五秒。
  const { IsolatedShellExecutor: CompiledExecutor } = await import(compiledSource(root, 'isolated-shell-executor'));
  const { ShellExecutor: CompiledShell } = await import(compiledSource(root, 'shell-executor'));
  return new CompiledExecutor(new CompiledShell(), { isolatedLane: 'operation', concurrency: 1 }) as IsolatedShellExecutor;
}

function casePhases(caseId: string) {
  const start = performance.now();
  return (phase: string) => console.info('[retention-fixture]', JSON.stringify({ caseId, phase, elapsedMs: Math.round(performance.now() - start) }));
}

function writeRunner(root: string, generation: 'A' | 'B', holdToken: string, refuseRetirement = false, holdCopy = true) {
  const runner = path.join(root, '.owned', `generation-${generation}.mjs`);
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SelfMaintenanceRuntime } from ${JSON.stringify(compiledSource(root, 'self-maintenance-runtime'))};
import { IsolatedShellExecutor } from ${JSON.stringify(compiledSource(root, 'isolated-shell-executor'))};
import { ShellExecutor } from ${JSON.stringify(compiledSource(root, 'shell-executor'))};
import { createSelfUpdateCheckpoint, prepareDetachedCdsRestart } from ${JSON.stringify(compiledSource(root, 'self-update-handoff'))};
import { confirmMaintenanceBoot } from ${JSON.stringify(compiledSource(root, 'self-maintenance-retention'))};
const root = ${JSON.stringify(root)}, generation = ${JSON.stringify(generation)};
const jobs = [], operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
let checkpointPath = '', snapshot, owner, report, cleanup;
const runtime = new SelfMaintenanceRuntime({ exec: operation.exec.bind(operation),
  execOwnedOperation: async (command, options) => {
    const input = /self-maintenance-files-process\\.(ts|js)/.test(command) ? JSON.parse(options.stdin || '{}') : undefined;
    let assignment;
    if (input?.action === 'snapshot') checkpointPath = input.backup.path;
    if (input?.action === 'retire' && ${JSON.stringify(refuseRetirement)}) {
      fs.writeFileSync(path.join(root, '.owned/old-retirement-input.json'), options.stdin);
      fs.mkdirSync(path.join(input.backup.path, '.retirement-writer.json')); // 实际EEXIST，不伪造worker结果。
    }
    const result = await operation.execOwnedOperation(command, { ...options,
      env: { ...options.env, ...(generation === 'B' && input?.action === 'snapshot' && ${JSON.stringify(holdCopy)}
        ? { NODE_OPTIONS: '--require=' + JSON.stringify(path.join(root, '.owned/copy-gate.cjs')) } : {}) },
      onAssigned: value => { assignment = { ...value }; options.onAssigned?.(value); },
      onData: (chunk, channel) => {
        options.onData?.(chunk, channel);
        if (generation === 'B' && chunk.includes(${JSON.stringify(holdToken)})) process.stdout.write(${JSON.stringify(holdToken)});
      },
    });
    if (input) { jobs.push({ action: input.action, assignment, exitCode: result.exitCode });
      if (input.action === 'snapshot' && result.exitCode === 0) snapshot = JSON.parse(result.stdout); }
    return result;
  },
}, root, () => {});
const close = () => cleanup ??= (async () => { await runtime.close(); await operation.close(); })();
process.on('SIGTERM', () => { if (owner) { try { runtime.requestStop(owner); } catch {} } void close(); });
try {
  confirmMaintenanceBoot(root); // 组件实际初始化接线；不能替代原index监听成功回执。
  owner = runtime.acquire({ source: 'self-update', actor: 'retention-' + generation });
  if (!owner) throw new Error('fixture owner unavailable');
  const checkpoint = await createSelfUpdateCheckpoint(runtime, owner, root);
  const head = await runtime.exec(owner, 'git rev-parse HEAD', { cwd: root });
  const branch = await runtime.exec(owner, 'git symbolic-ref --quiet --short HEAD', { cwd: root });
  if (head.exitCode !== 0 || branch.exitCode !== 0) throw new Error('fixture Git identity failed');
  let restartChild;
  const permit = prepareDetachedCdsRestart((...args) => { restartChild = spawn(...args); return restartChild; },
    path.join(root, 'cds'), { ...process.env }, ['ignore', 'ignore', 'ignore']);
  restartChild.ref();
  try { await permit.release(); owner.restartScheduled = true; await checkpoint.retainForRestart(); }
  finally { await permit.cancel(); }
  const afterRetainJobs = jobs.length;
  await checkpoint.rollback(); // finished后的原恢复调用必须无害，不能重开旧写者。
  report = { pid: process.pid, ownerId: owner.id, backupPath: checkpointPath,
    sourceHead: head.stdout.trim(), branch: branch.stdout.trim(), snapshot, jobs,
    afterRetainJobs, afterRollbackJobs: jobs.length, permitExitCode: restartChild.exitCode,
    permitSignal: restartChild.signalCode, runtimeAfter: runtime.observe() };
} catch (error) {
  report = { error: String(error), pid: process.pid, ownerId: owner?.id, backupPath: checkpointPath,
    jobs, snapshot, runtimeAfter: runtime.observe() };
  process.exitCode = 1;
} finally { await close(); }
report.closed = true;
report.poolAfter = { active: operation.getStats().active, queued: operation.getStats().queued };
fs.writeFileSync(path.join(root, '.owned', 'report-' + generation + '.json'), JSON.stringify(report));
`);
  return runner;
}

afterEach(async () => {
  // 只解除自有真实FS闸，不把失败收尾当作业务通过；外层原owned池负责终止其命令。
  for (const file of releases.splice(0)) fs.writeFileSync(file, 'release');
  const closed = await Promise.allSettled(pools.splice(0).map(pool => pool.close()));
  await Promise.allSettled(executions.splice(0));
  for (const { root, mayRemove } of roots.splice(0)) {
    if (mayRemove && closed.every(result => result.status === 'fulfilled')) fs.rmSync(root, { recursive: true, force: true });
    else console.warn('[retention-fixture] 未确认完整收尾，保留本任务恢复目录：', root);
  }
});

describe('受管恢复副本的真实Node换代与完整替代点', () => {
  it('完整B之前保留A，正常旧Node终态后仅回收精确A并保留B及未知副本', async () => {
    const phase = casePhases('complete-replacement');
    const { root, owned, git, seed } = makeFixture();
    const operation = await compileFixture(root); phase('compiled-esm-ready');
    pools.push(operation);
    const releaseFile = path.join(root, '.owned/release-copy'); releases.push(releaseFile);
    const heldFile = path.join(root, '.owned/held-copy.json'), holdToken = 'retention-fixture-B-copy-held';
    const preload = `const fs=require('node:fs');const cp=fs.promises.cp.bind(fs.promises);fs.promises.cp=async(source,target,options)=>{await cp(source,target,options);if(String(target).startsWith(${JSON.stringify(path.join(root, 'cds/.cds/restart-rollback-'))})&&String(target).endsWith('/0')){fs.writeFileSync(${JSON.stringify(heldFile)},JSON.stringify({target}));process.stderr.write(${JSON.stringify(holdToken)});while(!fs.existsSync(${JSON.stringify(releaseFile)}))await new Promise(resolve=>setTimeout(resolve,10));}};`;
    fs.writeFileSync(path.join(root, '.owned/copy-gate.cjs'), preload);
    const run = (generation: 'A' | 'B', onData?: (chunk: string) => void) => {
      const runner = writeRunner(root, generation, holdToken);
      // 净环境、不访问HOME/全局Git配置；两个Node和各自文件worker都是真实进程。
      const env = { ...gitEnv, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: path.join(root, '.owned/tmp') };
      const prefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
      const command = `/usr/bin/env -i ${prefix} ${shellQuote(process.execPath)} ${shellQuote(runner)}`;
      const execution = operation.execOwnedOperation(command, { cwd: fileURLToPath(new URL('../../', import.meta.url)),
        beforeStart: () => {}, onData: chunk => onData?.(chunk) });
      executions.push(execution); return execution;
    };
    const read = (generation: 'A' | 'B') => JSON.parse(fs.readFileSync(path.join(root, '.owned', `report-${generation}.json`), 'utf8')) as Report;
    const complete = (report: Report, generation: string) => {
      expect(report.pid).toBeGreaterThan(1); expect(report.pid).not.toBe(process.pid);
      expect(report.snapshot).toMatchObject({ ownerId: report.ownerId, existed: [true, true, true, true, true], artifactsRestored: false });
      expect(report.jobs.filter(job => job.action === 'snapshot')).toHaveLength(1);
      expect(report.jobs.every(job => job.exitCode === 0 && job.assignment?.lane === 'operation'
        && (job.assignment.actorPid ?? 0) > 1 && (job.assignment.factoryPid ?? 0) > 1)).toBe(true);
      expect(report.afterRollbackJobs).toBe(report.afterRetainJobs);
      expect(report.permitExitCode).toBe(0); expect(report.permitSignal).toBeNull();
      expect(report.runtimeAfter).toMatchObject({ restartScheduled: true, activeJobCount: 0, unconfirmedJobCount: 0 });
      expect(report.closed).toBe(true); expect(report.poolAfter).toEqual({ active: 0, queued: 0 });
      for (const [index, relative] of directories.entries()) {
        expect(fs.readFileSync(path.join(report.backupPath, String(index), 'fixture'), 'utf8')).toBe(`${generation}:${relative}`);
      }
    };
    const first = await run('A'); expect(first.exitCode, first.stderr).toBe(0);
    phase('A-node-closed');
    const a = read('A'); complete(a, 'A');
    expect(a.sourceHead).toBe(git('rev-parse', 'HEAD')); expect(a.branch).toBe('before');
    // A由外层owned命令确认实际退出；不是仅比较两个PID或虚构旧daemon已停。
    expect(fs.existsSync(a.backupPath)).toBe(true);
    const unknown = fs.mkdtempSync(path.join(root, 'cds/.cds/restart-rollback-00000000-0000-0000-0000-000000000000-'));
    fs.writeFileSync(path.join(unknown, 'sentinel'), 'unknown historical backup');
    git('checkout', '--quiet', '-b', 'after');
    fs.writeFileSync(path.join(root, 'source.txt'), 'generation-B'); git('add', 'source.txt'); git('commit', '--quiet', '-m', '保留副本后继夹具');
    seed('B');
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    let output = '';
    const second = run('B', chunk => { output = (output + chunk).slice(-1024); if (output.includes(holdToken)) held(); });
    await Promise.race([holding, second.then(result => { throw new Error(`B未进入真实复制闸：${result.exitCode}`); })]);
    phase('B-partial-copy-held');
    const partial = JSON.parse(fs.readFileSync(heldFile, 'utf8')) as { target: string };
    expect(fs.readFileSync(path.join(partial.target, 'fixture'), 'utf8')).toBe('B:dist');
    expect(fs.existsSync(path.join(path.dirname(partial.target), '1/fixture'))).toBe(false);
    expect(fs.existsSync(a.backupPath)).toBe(true); // 真实B仍未完整，不得提前删最后恢复点。
    expect(fs.readFileSync(path.join(unknown, 'sentinel'), 'utf8')).toBe('unknown historical backup');
    fs.writeFileSync(releaseFile, 'release');
    const last = await second; expect(last.exitCode, last.stderr).toBe(0);
    phase('B-node-closed');
    const b = read('B'); complete(b, 'B');
    expect(b.sourceHead).toBe(git('rev-parse', 'HEAD')); expect(b.sourceHead).not.toBe(a.sourceHead);
    expect(b.branch).toBe('after'); expect(b.backupPath).not.toBe(a.backupPath);
    expect(fs.readFileSync(path.join(root, 'cds/.cds/permit-invocations'), 'utf8')).toBe('daemon\ndaemon\n');
    expect(fs.readlinkSync(path.join(b.backupPath, '3/pkg'))).toBe('.pnpm/pkg/node_modules/pkg');
    expect(fs.readlinkSync(path.join(b.backupPath, '3/absolute-pkg'))).toBe(path.join(root, 'cds/node_modules/.pnpm/pkg/node_modules/pkg'));
    expect(fs.readlinkSync(path.join(b.backupPath, '3/.pnpm/pkg/node_modules/pkg/self'))).toBe('.');
    // 所有真实前置通过后，旧071应只在这条业务结果上语义RED；不依赖新增模块/API。
    expect.soft(fs.existsSync(a.backupPath), '后继完整B应替代并回收精确A').toBe(false);
    expect.soft(fs.existsSync(b.backupPath), 'B仍是可用恢复点').toBe(true);
    expect.soft(fs.readFileSync(path.join(unknown, 'sentinel'), 'utf8')).toBe('unknown historical backup');
    owned.mayRemove = true;
    phase('all-original-assertions-complete');
  });

  it('精确旧许可晚启动不删A，真实退役worker仍活时不接管、不分配第三份且保持B', async () => {
    const phase = casePhases('late-permit-live-writer');
    const { root, owned } = makeFixture();
    const operation = await compileFixture(root); phase('compiled-esm-ready');
    pools.push(operation);
    const cwd = fileURLToPath(new URL('../../', import.meta.url));
    const run = async (generation: 'A' | 'B', refuse = false) => {
      const runner = writeRunner(root, generation, 'unused-private-copy-gate', refuse, false);
      const prefix = Object.entries({ ...gitEnv, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        TMPDIR: path.join(root, '.owned/tmp') }).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
      const execution = operation.execOwnedOperation(`/usr/bin/env -i ${prefix} ${shellQuote(process.execPath)} ${shellQuote(runner)}`, { cwd, beforeStart: () => {} });
      executions.push(execution); return execution;
    };
    expect((await run('A')).exitCode).toBe(0);
    phase('A-node-closed');
    const a = JSON.parse(fs.readFileSync(path.join(root, '.owned/report-A.json'), 'utf8')) as Report;
    expect(fs.existsSync(a.backupPath)).toBe(true);
    // B的snapshot硬完成后，原retire worker遇到本任务真实EEXIST；原capture失败收尾不得丢B。
    const stopped = await run('B', true); expect(stopped.exitCode).toBe(1);
    phase('B-node-closed-retirement-refused');
    const b = JSON.parse(fs.readFileSync(path.join(root, '.owned/report-B.json'), 'utf8')) as Report;
    expect(b.jobs.map(job => [job.action, job.exitCode])).toEqual([['snapshot', 0], ['retire', 1]]);
    expect(b.snapshot.existed).toEqual([true, true, true, true, true]);
    expect(b.runtimeAfter).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 1 });
    expect(b.closed).toBe(true); expect(b.poolAfter).toEqual({ active: 0, queued: 0 });
    expect(fs.existsSync(a.backupPath)).toBe(true); expect(fs.existsSync(b.backupPath)).toBe(true);
    for (const index of directories.keys()) expect(fs.existsSync(path.join(b.backupPath, String(index), 'fixture'))).toBe(true);
    fs.rmdirSync(path.join(b.backupPath, '.retirement-writer.json')); // 唯一空的本任务故障注入入口。
    confirmMaintenanceBoot(root);
    const identity = maintenanceDirectoryIdentity(root), permit = retirementFor(identity)!;
    const file = path.join(root, 'cds/.cds/checkpoint-retention.json');
    const oldInput = fs.readFileSync(path.join(root, '.owned/old-retirement-input.json'), 'utf8');
    const worker = fileURLToPath(compiledSource(root, 'self-maintenance-files-process'));
    const command = `${shellQuote(process.execPath)} ${shellQuote(worker)}`;
    const late = await operation.execOwnedOperation(command, { cwd, stdin: oldInput, beforeStart: () => {} });
    expect(late.exitCode).toBe(1); expect(fs.existsSync(a.backupPath)).toBe(true);
    phase('late-permit-worker-closed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).revision).toBe(permit.revision);
    const release = path.join(root, '.owned/release-retirement'); releases.push(release);
    const held = path.join(root, '.owned/retirement-held'), token = 'retention-real-worker-after-delete';
    const preload = path.join(root, '.owned/retirement-gate.cjs');
    fs.writeFileSync(preload, `const fs=require('node:fs');const rm=fs.rmSync.bind(fs);fs.rmSync=(target,options)=>{const result=rm(target,options);if(target===${JSON.stringify(a.backupPath)}){fs.writeFileSync(${JSON.stringify(held)},'held');process.stderr.write(${JSON.stringify(token)});while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return result;};`);
    let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
    let output = '', assignment: ExecAssignment | undefined;
    const recovery = operation.execOwnedOperation(command, { cwd, beforeStart: () => {},
      stdin: JSON.stringify({ ...JSON.parse(oldInput), retirement: permit }),
      env: { NODE_OPTIONS: '--require=' + JSON.stringify(preload) },
      onAssigned: value => { assignment = { ...value }; },
      onData: chunk => { output = (output + chunk).slice(-1024); if (output.includes(token)) entered(); },
    });
    executions.push(recovery);
    await Promise.race([entering, recovery.then(result => { throw new Error(`真实退役未到达删除后闸：${result.exitCode}`); })]);
    phase('real-retirement-worker-held');
    expect(fs.readFileSync(held, 'utf8')).toBe('held'); expect(fs.existsSync(a.backupPath)).toBe(false);
    expect(assignment).toMatchObject({ lane: 'operation' }); expect(assignment!.actorPid).toBeGreaterThan(1);
    const claim = JSON.parse(fs.readFileSync(path.join(b.backupPath, '.retirement-writer.json'), 'utf8'));
    expect(claim.token).toBe(permit.token); expect(claim.birth.pid).toBeGreaterThan(1);
    expect(() => process.kill(a.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => process.kill(b.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => process.kill(claim.birth.pid, 0)).not.toThrow();
    expect(() => retirementFor(identity)).toThrow('身份或终态未确认');
    const instance = new (await import('../../src/services/self-maintenance-runtime.js')).SelfMaintenanceRuntime(operation, root, () => {});
    const ticket = instance.acquire({ source: 'self-update', actor: 'must-not-allocate-third' })!;
    try { expect(() => instance.prepareCheckpoint(ticket)).toThrow('身份或终态未确认'); }
    finally { await instance.close(); }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ revision: permit.revision, slots: [{ ownerId: a.ownerId }, { ownerId: b.ownerId }] });
    for (const index of directories.keys()) expect(fs.existsSync(path.join(b.backupPath, String(index), 'fixture'))).toBe(true);
    fs.writeFileSync(release, 'release');
    expect((await recovery).exitCode).toBe(0);
    phase('real-retirement-worker-closed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).slots).toEqual([expect.objectContaining({ ownerId: b.ownerId, phase: 'retained' })]);
    expect(fs.existsSync(b.backupPath)).toBe(true); owned.mayRemove = true;
    phase('all-original-assertions-complete');
  });
});
