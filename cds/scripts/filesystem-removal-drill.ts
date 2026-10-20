import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const referenceHead = '913b9d6a9b98ef5b44d056f5a181c053a5dd9bca';
const sources = ['src/executor/routes.ts', 'src/routes/branches.ts', 'src/routes/legacy-cleanup.ts',
  'src/routes/remote-hosts.ts', 'src/services/container.ts', 'src/services/github-webhook-dispatcher.ts',
  'src/services/isolated-shell-executor.ts', 'src/services/janitor.ts', 'src/services/state.ts',
  'src/services/worktree-path-activity.ts', 'src/services/worktree-directory-removal-process.ts',
  'src/services/worktree.ts', 'src/types.ts', 'tests/services/janitor-filesystem-removal.test.ts',
  'tests/services/worktree-claim-handoff.test.ts', 'tests/services/worktree-path-activity.test.ts',
  'tests/services/janitor-observation.test.ts',
  'scripts/filesystem-removal-drill.ts'];
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux');
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const output = path.resolve('filesystem-removal-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cds-fs-removal-native-')));
  await fs.chmod(temp, 0o700);
  const report: Record<string, any> = {
    head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(), verdict: 'failed', referenceHead, checks: [],
    sourceHashes: Object.fromEntries(await Promise.all(sources.map(async name => [name, digest(await fs.readFile(name))]))),
    scope: 'compiled production filesystem adapter, owned operation pool, actual private filesystem and Git; local control-process claim protocol',
    actualApplicationDeploymentVerified: false, performanceVerified: false,
    crossProcessClaimVerified: false, restartFencingVerified: false, actualOsCleanupFailureVerified: false,
    asyncDestructionVerified: false, privateFilesRemoved: false,
  };
  try {
    report.stage = 'fixed-old-adapter';
    execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', referenceHead], { stdio: 'pipe', timeout: 120000 });
    assert.equal(execFileSync('/usr/bin/git', ['diff', '--name-only', referenceHead, report.head, '--',
      ':(top)cds/package.json', ':(top)cds/pnpm-lock.yaml'], { encoding: 'utf8' }).trim(), '');
    const original = execFileSync('/usr/bin/git', ['show', `${referenceHead}:cds/src/services/janitor.ts`]);
    const runtime = path.join(temp, 'old-adapter-runtime'); await fs.cp(path.resolve('dist'), runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, 'package.json'), '{"type":"module"}\n');
    await fs.symlink(path.resolve('node_modules'), path.join(runtime, 'node_modules'), 'dir');
    const compiled = ts.transpileModule(original.toString('utf8'), { fileName: 'janitor.ts', reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, useDefineForClassFields: true,
        newLine: ts.NewLineKind.LineFeed, sourceMap: true, removeComments: false } });
    assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
    await fs.writeFile(path.join(runtime, 'services/janitor.js'), compiled.outputText);
    report.referenceSourceHashes = { 'src/services/janitor.ts': digest(original) };
    report.referenceCompiledJanitorHash = digest(compiled.outputText); report.compilerVersion = ts.version;
    // This is the original adapter method only, not a claim about the entire old State protocol.
    const old = await import(pathToFileURL(path.join(runtime, 'services/janitor.js')).href);
    const dir = path.join(temp, 'old-private-files'); await fs.mkdir(dir);
    for (let batch = 0; batch < 256; batch++) await Promise.all(Array.from({ length: 16 }, (_, i) =>
      fs.writeFile(path.join(dir, `file-${batch * 16 + i}`), 'private-original-content')));
    let ticks = 0; const timer = setInterval(() => ticks++, 1), started = performance.now();
    let error: unknown;
    try { error = await old.createJanitorDockerAdapters({ exec: async () => { throw new Error('No shell fallback allowed'); } }).orphanWorktreeFs.removeDir(dir); }
    finally { clearInterval(timer); }
    const removed = await fs.access(dir).then(() => false, () => true);
    report.referenceRemoval = { files: 4096, ticksDuringRemoval: ticks, elapsedMs: performance.now() - started, removed, error };
    assert.equal(error, null); assert.equal(removed, true); assert.equal(ticks, 0);
    report.checks.push({ name: 'original-recursive-removal-blocks-control-timer', passed: true });
    report.stage = 'compiled-private-ownership-tests';
    const tests = spawnSync('pnpm', ['exec', 'vitest', 'run', 'tests/services/janitor-filesystem-removal.test.ts',
      'tests/services/worktree-claim-handoff.test.ts'], { encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CDS_FS_REMOVAL_COMPILED_DIR: path.resolve('dist'),
        CDS_FS_REMOVAL_NATIVE_OUTPUT: path.join(output, 'test-receipts.json') } });
    const testLog = `${tests.stdout || ''}\n${tests.stderr || ''}`;
    await fs.writeFile(path.join(output, 'test.log'), testLog, { mode: 0o600 });
    report.testExitCode = tests.status; assert.equal(tests.status, 0);
    const receipt = JSON.parse(await fs.readFile(path.join(output, 'test-receipts.json'), 'utf8'));
    assert.equal(receipt.mode, 'compiled'); assert.equal(receipt.checks.length, 7);
    assert.ok(receipt.checks.every((row: any) => row.poolZero === true));
    assert.ok(receipt.processClosures.length >= 28);
    assert.ok(receipt.processClosures.every((row: any) => row.state === '' || row.state.startsWith('Z')));
    assert.equal(receipt.privateFilesRemoved, true);
    report.nativeOwnership = receipt;
    for (const row of receipt.checks) report.checks.push({ name: row.name, passed: true });
    const jsonLines = testLog.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const actualRemoval = jsonLines.find(row => row.actualOwnedRecursiveRemoval === true);
    assert.equal(actualRemoval?.files, 2049); assert.ok(actualRemoval.ticksDuringRemoval > 0);
    const handoff = jsonLines.find(row => row.actualGitClaimHandoff === true);
    assert.match(handoff?.gitHead || '', /^[0-9a-f]{40}$/); assert.equal(handoff?.rawFallbackCalls, 0);
    assert.equal(handoff?.eligibleAgeProtected, true); assert.equal(handoff?.actualStateRegistered, true);
    const gitClosed=jsonLines.find(row=>row.actualGitPoolClosed===true);
    assert.equal(gitClosed?.closedProcesses?.length,4);
    assert.ok(gitClosed.closedProcesses.every((row:any)=>!row.state||row.state.startsWith('Z')));
    report.candidateRemoval = actualRemoval; report.gitClaimHandoff = handoff;report.gitPoolClosure=gitClosed;
    report.checks.push({ name: 'actual-owned-git-create-through-state-handoff', passed: true });
    const runtimePaths = ['services/janitor.js', 'services/state.js', 'services/orphan-worktree.js',
      'services/worktree.js', 'infra/state-store/json-backing-store.js', 'services/worktree-path-activity.js',
      'services/worktree-directory-removal-process.js', 'services/isolated-shell-executor.js'];
    report.compiledRuntimeHashes = Object.fromEntries(await Promise.all(runtimePaths.map(async name =>
      [name, digest(await fs.readFile(path.join('dist', name)))])));
    report.operationPoolBounds = { concurrency: 2, maxQueued: 4, maxBytes: 256 * 1024, reservedCleanup: 1, reservedCleanupBytes: 64 * 1024 };
    report.asyncDestructionVerified = true; report.verdict = 'passed';
  } catch (error) { report.failure = { name: error instanceof Error ? error.name : 'Error' }; throw error; }
  finally {
    await fs.rm(temp, { recursive: true, force: true }); report.privateFilesRemoved = true;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.name : 'Error'); process.exitCode = 1; });
