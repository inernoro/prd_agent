import { afterEach, expect, it, vi } from 'vitest';
import * as cp from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import express from 'express';
import { AsyncStuckDeployReconciler } from '../../src/services/async-stuck-deploy-reconciler.js';
import { createReleaseGitRunner } from '../../src/services/release-git-reader.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { createCdsSystemDiagnosticsRouter } from '../../src/routes/cds-system-diagnostics.js';
import type { BranchEntry, BuildProfile, IShellExecutor } from '../../src/types.js';
vi.mock('node:child_process', async original => { const actual = await original<typeof import('node:child_process')>(); return { ...actual, exec: vi.fn(actual.exec), execSync: vi.fn(actual.execSync), execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) }; });
const pools: IsolatedShellExecutor[] = []; const dirs: string[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(p => p.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); vi.restoreAllMocks(); });
it('真实巡检Git阻塞时生命周期和诊断可用，读取归属操作actor且只核对新状态', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cds-watchdog-owned-')); dirs.push(dir);
  const git = (...args: string[]) => cp.execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Owned Watchdog'); git('config', 'user.email', 'owned@example.test');
  await mkdir(path.join(dir, 'prd-admin/src'), { recursive: true }); const file = path.join(dir, 'prd-admin/src/App.tsx');
  await writeFile(file, 'first'); git('add', '.'); git('commit', '-qm', '自有第一版'); const first = git('rev-parse', 'HEAD');
  await writeFile(file, 'second'); git('add', '.'); git('commit', '-qm', '自有第二版'); const second = git('rev-parse', 'HEAD');
  const marker = path.join(dir, 'producer.json'), release = path.join(dir, 'release'), shim = path.join(dir, 'git');
  await writeFile(shim, `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(t);const p=cp.spawn('/usr/bin/git',process.argv.slice(2),{stdio:'inherit'});p.on('error',()=>process.exit(1));p.on('close',c=>process.exit(c??1));},10);\n`); await chmod(shim, 0o700);
  const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2, reservedCleanup: 1 }); const shell = new IsolatedShellExecutor(operation); pools.push(shell, operation); await Promise.all([shell.start(), operation.start()]);
  vi.mocked(cp.exec).mockClear(); vi.mocked(cp.execSync).mockClear(); vi.mocked(cp.spawn).mockClear(); vi.mocked(cp.execFileSync).mockClear();
  // 私有fixture延长持有以核对读取尚未完成；生产helper期限仍为3秒，前批已单独验证。
  const executor: IShellExecutor = { exec: (c, o) => shell.exec(c, o), execBackgroundObservation: (c, o) => shell.execBackgroundObservation(c, { ...o, env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 10000 }) };
  const old = { id: 'owned', projectId: 'owned', branch: 'owned', worktreePath: dir, services: {}, status: 'running', createdAt: new Date().toISOString(), ciImageStatus: 'ready', ciTargetSha: first, githubCommitSha: second } as BranchEntry;
  const life = { ...old, id: 'life', ciImageStatus: undefined, status: 'starting', lastDeployStartedAt: '2026-06-27T00:18:00.000Z', lastReadyAt: '2026-06-27T01:01:00.000Z' } as BranchEntry;
  let current = old; const saved = vi.fn(), emit = vi.fn(); const profiles = [{ id: 'web', activeDeployMode: 'express', deployModes: { express: { prebuilt: true } } }] as unknown as BuildProfile[];
  const runner = new AsyncStuckDeployReconciler({ getBranches: () => [current, life], getOptions: () => ({ getBuildProfiles: () => profiles, emitBranchUpdated: emit }), git: createReleaseGitRunner(executor), onReconciled: saved });
  const app = express(); app.use('/api', createCdsSystemDiagnosticsRouter()); const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  let completed = false; const pending = runner.run().then(() => { completed = true; });
  try {
    expect(life.status).toBe('running'); expect(saved).toHaveBeenCalledOnce();
    let producer: { pid: number } | undefined;
    for (let i = 0; i < 300; i++) { try { producer = JSON.parse(await readFile(marker, 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    expect(producer).toBeDefined(); expect(operation.getStats().active).toBe(1); expect(shell.getStats().active).toBe(0);
    const group = await shell.exec(`ps -p ${producer!.pid} -o pgid=`, { executionLane: 'observation' }); expect(operation.getStats().actors.some(a => a.pid === Number(group.stdout.trim()))).toBe(true);
    const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: (server.address() as { port: number }).port, path: '/api/cds-system/diagnostics/main-thread' }, res => { let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) })); }); req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Owned diagnostic timed out')));
    });
    expect(response.status).toBe(200); expect(response.body).toHaveProperty('eventLoop'); expect(completed).toBe(false); expect(old.ciImageError).toBeUndefined();
    current = { ...old, services: {}, githubCommitSha: 'c'.repeat(40) };
    expect(cp.exec).not.toHaveBeenCalled(); expect(cp.execSync).not.toHaveBeenCalled(); expect(cp.spawn).not.toHaveBeenCalled(); expect(cp.execFileSync).not.toHaveBeenCalled();
  } finally { await writeFile(release, 'owned'); await pending; await new Promise<void>(r => server.close(() => r())); }
  expect(old.ciImageError).toBeUndefined(); expect(current.ciImageError).toBeUndefined();
  current.githubCommitSha = second; await runner.run(); expect(current.ciImageError).toContain('镜像落后'); expect(emit).toHaveBeenCalledWith(current);
  expect(operation.getStats().active).toBe(0); expect(operation.getStats().bytes).toBe(0);
}, 15000);
