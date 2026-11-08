import assert from 'node:assert/strict';
import { assertCurrentSourceQualification } from './current-source-qualification.js';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { CdsConfig } from '../src/types.js';

const referenceHead = 'b81cfe70f6b7602e882668cd8d9e43c19d5e1592';
const inheritedCandidateHead = '2884f9a9cffdb6447658b25497beb4f3cacdc6c7';
// 保留旧历史范围/编译黄金；本批新增按需能力准备及探针归属这一源，不能抵扣旧路径语义。
const currentSourceChanges = ['src/executor/routes.ts', 'src/index.ts', 'src/middleware/github-auth.ts', 'src/routes/access-requests.ts', 'src/routes/branches.ts', 'src/routes/cache.ts', 'src/routes/projects.ts', 'src/routes/remote-hosts.ts', 'src/server.ts', 'src/services/agent-workspace-session-runtime.ts', 'src/services/artifact-admission.ts', 'src/services/branch-operation-coordinator.ts', 'src/services/cds-events-bus.ts', 'src/services/compose-parser.ts', 'src/services/container.ts', 'src/services/core-image-cache.ts', 'src/services/deployment-phase-budget.ts', 'src/services/forwarder-route-publisher.ts', 'src/services/github-webhook-dispatcher.ts', 'src/services/internal-pending-replay-auth.ts', 'src/services/isolated-shell-executor.ts', 'src/services/observation-stream-executor.ts', 'src/services/observation-supervisor-process.ts', 'src/services/proxy.ts', 'src/services/resource-usage-sampler.ts', 'src/services/running-version.ts', 'src/services/service-replacement.ts', 'src/services/service-runtime.ts', 'src/services/state.ts', 'src/services/uptime-history-write.ts', 'src/services/uptime-monitor.ts', 'src/types.ts', 'src/widget-script.ts'];
const changedSources = ['src/routes/branches.ts', 'src/services/worktree-path-activity.ts'];
const sources = [...changedSources, 'src/services/worktree.ts', 'src/services/janitor.ts', 'src/services/state.ts',
  'src/services/container.ts', 'src/services/isolated-shell-executor.ts', 'src/services/secure-database-cli.ts',
  'src/services/worktree-directory-removal-process.ts', 'src/services/self-status-cache.ts',
  'src/infra/state-store/json-backing-store.ts', 'scripts/branch-claim-entry-drill.ts'];
const runtimeFiles = ['routes/branches.js', 'services/worktree-path-activity.js', 'services/worktree.js',
  'services/janitor.js', 'services/state.js', 'services/isolated-shell-executor.js',
  'services/worktree-directory-removal-process.js', 'infra/state-store/json-backing-store.js'];
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const git = (args: string[], cwd?: string) => execFileSync('/usr/bin/git', args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
const closure = (pid: number) => {
  let state = ''; try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
  return { pid, state };
};

async function exercise(runtime: string, root: string, duplicateStatus: number, native: boolean, record: (result: Record<string, any>) => void) {
  const module = (name: string) => import(pathToFileURL(path.join(runtime, `${name}.js`)).href);
  const { StateService } = await module('services/state') as typeof import('../src/services/state.js');
  const { WorktreeService } = await module('services/worktree') as typeof import('../src/services/worktree.js');
  const { IsolatedShellExecutor } = await module('services/isolated-shell-executor') as typeof import('../src/services/isolated-shell-executor.js');
  const { ContainerService } = await module('services/container') as typeof import('../src/services/container.js');
  const { JanitorService, createJanitorDockerAdapters } = await module('services/janitor') as typeof import('../src/services/janitor.js');
  const { createBranchRouter } = await module('routes/branches') as typeof import('../src/routes/branches.js');
  const { worktreePathActivity } = await module('services/worktree-path-activity') as typeof import('../src/services/worktree-path-activity.js');
  const { selfStatusCache } = await module('services/self-status-cache') as typeof import('../src/services/self-status-cache.js');
  let rawFallbackCalls = 0, release = () => {}, server: http.Server | undefined;
  let firstResponse: Promise<{ status: number; body: any }> | undefined, pids: number[] = [];
  const op = new IsolatedShellExecutor({ exec: async () => { rawFallbackCalls++; throw new Error('Forbidden raw fallback'); } },
    { isolatedLane: 'operation', concurrency: 2, maxQueued: 4, maxBytes: 256 * 1024, reservedCleanup: 1, reservedCleanupBytes: 64 * 1024 });
  const shell = new IsolatedShellExecutor(op, { concurrency: 1, maxQueued: 4, maxBytes: 256 * 1024 });
  const stateFile = path.join(root, 'state.json'), state = new StateService(stateFile);
  const result: Record<string, any> = { duplicateExpected: duplicateStatus, mountTableVerified: false,
    scope: 'actual manual branch HTTP router, compiled worktree/State/Janitor, owned processes and private Git/FS',
    ownedProcessesRemoved: false, privateFilesRemoved: false, checks: [] };
  record(result);
  try {
    const source = path.join(root, 'source'), repo = path.join(root, 'repo'); await fs.mkdir(source, { recursive: true });
    git(['init', '--initial-branch=main'], source); git(['config', 'user.name', 'private-test'], source);
    git(['config', 'user.email', 'private-test@example.invalid'], source);
    await fs.writeFile(path.join(source, 'marker'), 'actual-private-api-git'); git(['add', '.'], source);
    git(['commit', '-m', '私有HTTP受理验证'], source); result.gitHead = git(['rev-parse', 'HEAD'], source);
    const branch = 'feature/api-claim'; git(['branch', branch], source); git(['clone', source, repo], root);
    const now = new Date().toISOString(); state.addProject({ id: 'proj', slug: 'proj', name: 'Private', kind: 'git', createdAt: now, updatedAt: now });
    const base = path.join(root, 'worktrees');
    const config: CdsConfig = { mode: 'standalone', executorPort: 5501, repoRoot: repo, worktreeBase: base, masterPort: 0, workerPort: 5500,
      dockerNetwork: 'private-no-docker', portStart: 10001, rootDomains: ['example.invalid'], previewDomain: 'example.invalid',
      sharedEnv: {}, jwt: { secret: 'private-fixture-only', issuer: 'private' } };
    await Promise.all([op.start(), shell.start()]); await op.exec('true', { executionLane: 'operation', timeout: 5000 });
    pids = [op, shell].flatMap(pool => { const s = pool.getStats(); return [s.supervisorPid!, s.factoryPid!, ...s.actors.map(a => a.pid)]; });
    const worktree = new WorktreeService(op), adapters = createJanitorDockerAdapters(shell);
    const readMounted = adapters.orphanWorktreeFs.listMountedHostPaths;
    const janitor = new JanitorService(state, { enabled: true, worktreeTTLDays: 7, diskWarnPercent: 80,
      sweepIntervalSeconds: 3600, dockerPrune: false, imageRetention: false }, base, undefined, () => null, undefined, undefined,
      { ...adapters.orphanWorktreeFs, listMountedHostPaths: async () => {
        if (!native) return [];
        const mounted = await readMounted(); assert.notEqual(mounted, null);
        result.mountTableVerified = true; result.mountedPathCount = mounted!.length; return mounted;
      } });
    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const create = worktree.create.bind(worktree); let createCalls = 0;
    worktree.create = async (...args) => {
      createCalls++; await create(...args);
      const dir = args[2], orphan = path.join(path.dirname(dir), 'unclaimed-control'); await fs.mkdir(orphan);
      await fs.writeFile(path.join(orphan, 'marker'), 'unclaimed-private-control');
      const old = new Date(Date.now() - 24 * 3600_000); await fs.utimes(dir, old, old); await fs.utimes(orphan, old, old);
      assert.equal(state.findBranchByProjectAndName('proj', branch), undefined);
      const sweep = await janitor.sweep();
      assert.equal(await fs.readFile(path.join(dir, 'marker'), 'utf8'), 'actual-private-api-git');
      await assert.rejects(fs.access(orphan)); assert.deepEqual(sweep.orphanWorktrees?.removed, [orphan]);
      result.beforeRegistration = { dir, claimedInState: false, protectedMarker: true, actualUnclaimedRemoval: true,
        keptReason: sweep.orphanWorktrees?.keptReasons[dir], activity: worktreePathActivity.getStats() };
      enteredResolve(); await gate;
    };
    const app = express(); app.use(express.json()); app.use('/api', createBranchRouter({ stateService: state,
      worktreeService: worktree, containerService: new ContainerService(shell, config), shell, config }));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const request = (method: string, url: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port: (server!.address() as { port: number }).port, path: url, method, agent: false,
        headers: { 'Content-Type': 'application/json', ...(text ? { 'Content-Length': Buffer.byteLength(text) } : {}) } }, res => {
        let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); } catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('Private HTTP request deadline exceeded')));
      req.on('error', reject); if (text) req.write(text); req.end();
    });
    firstResponse = request('POST', '/api/branches', { projectId: 'proj', branch });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([entered, firstResponse.then(v => { throw new Error(`First request ended before checkpoint: ${v.status}`); }),
      new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Create checkpoint missing')), 5000); })])
      .finally(() => clearTimeout(timer));
    const read = await request('GET', '/api/branches'); assert.equal(read.status, 200);
    const duplicate = await request('POST', '/api/branches', { projectId: 'proj', branch }); result.duplicate = duplicate;
    assert.equal(duplicate.status, duplicateStatus); assert.equal(createCalls, 1);
    if (duplicateStatus === 409) { assert.equal(duplicate.body.code, 'worktree-held'); assert.match(duplicate.body.error, /稍后重试/); }
    else assert.match(duplicate.body.error, /工作目录正在创建或回收/);
    release(); const accepted = await firstResponse; assert.equal(accepted.status, 201);
    const entry = state.findBranchByProjectAndName('proj', branch)!; assert.ok(entry);
    assert.equal(git(['rev-parse', 'HEAD'], entry.worktreePath), result.gitHead);
    assert.equal(await fs.readFile(path.join(entry.worktreePath, 'marker'), 'utf8'), 'actual-private-api-git');
    assert.equal(Object.keys(JSON.parse(await fs.readFile(stateFile, 'utf8')).branches).length, 1);
    const existing = await request('POST', '/api/branches', { projectId: 'proj', branch }); assert.equal(existing.status, 409);
    assert.equal(createCalls, 1); assert.equal(state.getAllBranches().length, 1);
    const failed = await request('POST', '/api/branches', { projectId: 'proj', branch: 'missing-real-ref' });
    assert.equal(failed.status, 500); assert.match(failed.body.error, /拉取分支/);
    assert.equal(state.findBranchByProjectAndName('proj', 'missing-real-ref'), undefined);
    assert.equal(worktreePathActivity.getStats().active, 0);
    // 用另一个受管实际Node进程冷读原State，避免同进程共享存储缓存被误称持久化验证。
    const reader = path.join(root, 'cold-reader.mjs');
    await fs.writeFile(reader, `import {StateService} from ${JSON.stringify(pathToFileURL(path.join(runtime, 'services/state.js')).href)};
import fs from 'node:fs';import {execFileSync} from 'node:child_process';const ancestors=[];let parent=process.ppid;for(let i=0;i<4&&parent>1;i++){ancestors.push(parent);try{parent=Number(execFileSync('/bin/ps',['-o','ppid=','-p',String(parent)],{encoding:'utf8'}).trim());}catch{break;}}const state=new StateService(${JSON.stringify(stateFile)});state.load();
const b=state.findBranchByProjectAndName('proj',${JSON.stringify(branch)});
console.log('CDS_COLD_RECEIPT '+JSON.stringify({pid:process.pid,ppid:process.ppid,ancestors,id:b?.id,branch:b?.branch,marker:b&&fs.readFileSync(b.worktreePath+'/marker','utf8'),branches:state.getAllBranches().length}));`);
    const quote = (arg: string) => `'${arg.replace(/'/g, `'"'"'`)}'`;
    const originalCold = await op.execOwnedOperation(`${quote(process.execPath)} --max-old-space-size=128 ${quote(reader)}`,
      { executionLane: 'operation', cwd: root, timeout: 5000, beforeStart: () => { assert.equal(state.getAllBranches().length, 1); } });
    assert.equal(originalCold.exitCode, 0);
    const originalLine = originalCold.stdout.split('\n').find(line => line.startsWith('CDS_COLD_RECEIPT ')); assert.ok(originalLine);
    const originalReceipt = JSON.parse(originalLine.slice('CDS_COLD_RECEIPT '.length));
    result.originalColdReceipt = originalReceipt;
    result.originalImmediateParentMatchesActor = op.getStats().actors.some(actor => actor.pid === originalReceipt.ppid);
    assert.ok(op.getStats().actors.some(actor => originalReceipt.ancestors.includes(actor.pid)));
    assert.equal(originalReceipt.id, entry.id); assert.equal(originalReceipt.branches, 1);
    assert.equal(originalReceipt.marker, 'actual-private-api-git');
    pids.push(originalReceipt.pid);
    if (!pids.includes(originalReceipt.ppid)) pids.push(originalReceipt.ppid);
    const cold = await op.execOwnedOperation(`exec ${quote(process.execPath)} --max-old-space-size=128 ${quote(reader)}`,
      { executionLane: 'operation', cwd: root, timeout: 5000, beforeStart: () => { assert.equal(state.getAllBranches().length, 1); } });
    assert.equal(cold.exitCode, 0);
    const line = cold.stdout.split('\n').find(line => line.startsWith('CDS_COLD_RECEIPT ')); assert.ok(line);
    const receipt = JSON.parse(line.slice('CDS_COLD_RECEIPT '.length));
    result.coldReceipt = receipt; pids.push(receipt.pid);
    assert.notEqual(receipt.pid, process.pid); assert.ok(op.getStats().actors.some(actor => actor.pid === receipt.ppid));
    assert.equal(receipt.id, entry.id); assert.equal(receipt.branch, branch); assert.equal(receipt.branches, 1);
    assert.equal(receipt.marker, 'actual-private-api-git');
    result.coldReceipt = receipt; result.accepted = { status: accepted.status, branchId: entry.id };
    result.readWhileInFlight = { status: read.status }; result.existingConflictStatus = existing.status;
    result.actualGitFailureStatus = failed.status; result.createCalls = createCalls; result.rawFallbackCalls = rawFallbackCalls;
    assert.equal(rawFallbackCalls, 0);
    result.checks = [{ name: 'actual-HTTP-handoff-protection-and-owned-control-deletion', passed: true },
      { name: 'actual-inflight-conflict-and-one-created-branch', passed: true },
      { name: 'actual-Git-failure-not-misclassified-as-conflict', passed: true },
      { name: 'acknowledged-creation-cold-read-through-original-State', passed: true }];
    return result;
  } finally {
    release(); await firstResponse?.catch(() => {}); selfStatusCache._resetForTests();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await shell.close(); await op.close(); result.closedProcesses = pids.map(closure);
    assert.ok(result.closedProcesses.every((row: { state: string }) => !row.state || row.state.startsWith('Z')));
    result.poolAfter = [op.getStats(), shell.getStats()];
    assert.ok(result.poolAfter.every((row: any) => row.active === 0 && row.queued === 0 && row.bytes === 0));
    result.ownedProcessesRemoved = true; await state.flush(); await fs.rm(root, { recursive: true, force: true }); result.privateFilesRemoved = true;
  }
}

async function main() {
  const native = process.argv.includes('--native');
  if (native) { assert.equal(process.platform, 'linux'); assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/); }
  const output = path.resolve('branch-claim-entry-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cds-http-claim-native-')));
  const head = git(['rev-parse', 'HEAD']);
  const report: Record<string, any> = { head, referenceHead, platform: process.platform, node: process.version, native, verdict: 'failed', checks: [],
    sourceHashes: Object.fromEntries(await Promise.all(sources.map(async name => [name, digest(await fs.readFile(name))]))),
    actualManualBranchHttpHandoffVerified: false, actualApplicationDeploymentVerified: false, performanceVerified: false,
    otherCreationEntrypointsVerified: false, crossProcessClaimVerified: false, restartFencingVerified: false,
    fullResourceBudgetVerified: false, privateFilesRemoved: false };
  try {
    if (native) git(['fetch', '--depth', '1', 'origin', referenceHead, inheritedCandidateHead]);
    report.inheritedCandidateHead = inheritedCandidateHead;
    report.inheritedProductionSources = git(['diff', '--name-only', referenceHead, inheritedCandidateHead, '--', ':(top)cds/src']).split('\n').filter(Boolean).sort();
    assert.deepEqual(report.inheritedProductionSources, changedSources.map(name => `cds/${name}`).sort());
    report.changedProductionSources = git(['diff', '--name-only', inheritedCandidateHead, '--', ':(top)cds/src']).split('\n').filter(Boolean).sort();
    assertCurrentSourceQualification(currentSourceChanges, report, native);
    assert.equal(git(['diff', '--name-only', referenceHead, '--', ':(top)cds/package.json', ':(top)cds/pnpm-lock.yaml']), '');
    const old = path.join(temp, 'reference-runtime'); await fs.cp(path.resolve('dist'), old, { recursive: true });
    await fs.writeFile(path.join(old, 'package.json'), '{"type":"module"}\n'); await fs.symlink(path.resolve('node_modules'), path.join(old, 'node_modules'), 'dir');
    report.referenceSourceHashes = {}; report.referenceCompiledRuntimeHashes = {};
    for (const name of changedSources) {
      const source = execFileSync('/usr/bin/git', ['show', `${referenceHead}:cds/${name}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const runtime = name.replace(/^src\//, '').replace(/\.ts$/, '.js');
      const compiled = ts.transpileModule(source, { fileName: path.basename(name), reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: true,
          newLine: ts.NewLineKind.LineFeed, sourceMap: true, removeComments: false } });
      assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
      await fs.writeFile(path.join(old, runtime), compiled.outputText);
      report.referenceSourceHashes[name] = digest(source); report.referenceCompiledRuntimeHashes[runtime] = digest(compiled.outputText);
    }
    assert.deepEqual(report.referenceCompiledRuntimeHashes, {
      'routes/branches.js': 'a28451ce220f3730ec1c6c05c019c94aabca2c998e472b93552ccaa351b8ae85',
      'services/worktree-path-activity.js': 'a9c72024c8afc3a91554c9fd11f0344969a429462bda6c5c95f14279870e9ec0'
    });
    report.compilerVersion = ts.version;
    report.compiledRuntimeHashes = Object.fromEntries(await Promise.all(runtimeFiles.map(async name => [name, digest(await fs.readFile(path.join('dist', name)))])));
    report.stage = 'actual-fixed-reference-HTTP'; report.reference = await exercise(old, path.join(temp, 'reference-case'), 500, native, result => { report.reference = result; });
    report.stage = 'actual-candidate-HTTP'; report.candidate = await exercise(path.resolve('dist'), path.join(temp, 'candidate-case'), 409, native, result => { report.candidate = result; });
    report.checks = [...report.reference.checks.map((row: any) => ({ ...row, name: `reference:${row.name}` })),
      ...report.candidate.checks.map((row: any) => ({ ...row, name: `candidate:${row.name}` }))];
    report.actualManualBranchHttpHandoffVerified = true; report.verdict = 'passed';
  } catch (error) { report.failure = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'Error' }; throw error; }
  finally {
    await fs.rm(temp, { recursive: true, force: true }); report.privateFilesRemoved = true;
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.name : 'Error'); process.exitCode = 1; });
