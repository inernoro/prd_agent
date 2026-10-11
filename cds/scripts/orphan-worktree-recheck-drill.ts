import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { runOrphanRecheckProbe, probeEnumerationYield, type RecheckCase } from './orphan-worktree-recheck-probe.js';
import { runOrphanOwnershipProbe, type OwnershipCase } from './orphan-worktree-ownership-probe.js';

const referenceHead = 'a64d9b2494c8a0e140dd678c9c4bd9b90e1935c4';
const inheritedCandidateHead = '2884f9a9cffdb6447658b25497beb4f3cacdc6c7';
// 保留旧历史范围/编译黄金；本批仅新增按需能力准备这一源，不能抵扣旧路径语义。
const currentSourceChanges = ['src/index.ts', 'src/middleware/github-auth.ts', 'src/routes/branches.ts', 'src/server.ts', 'src/services/agent-workspace-session-runtime.ts', 'src/services/branch-operation-coordinator.ts', 'src/services/internal-pending-replay-auth.ts'];
const ownershipReferenceHead = '766a259d8383da5e60e426819a97a110bfedf275';
const sources = ['src/services/janitor.ts', 'src/services/state.ts', 'src/services/orphan-worktree.ts',
  'src/services/worktree.ts', 'src/infra/state-store/json-backing-store.ts', 'scripts/orphan-worktree-recheck-drill.ts',
  'scripts/orphan-worktree-recheck-probe.ts', 'tests/services/janitor-orphan-worktree-recheck.test.ts',
  'src/services/worktree-path-activity.ts', 'scripts/orphan-worktree-ownership-probe.ts',
  'tests/services/janitor-orphan-worktree-ownership.test.ts', 'tests/services/worktree-path-activity.test.ts',
  'tests/services/deployment-source-concurrent.test.ts'];
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux');
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const output = path.resolve('orphan-recheck-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-orphan-recheck-')); await fs.chmod(temp, 0o700);
  const report: Record<string, any> = { head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(), verdict: 'failed', referenceHead,
    sourceHashes: Object.fromEntries(await Promise.all(sources.map(async name => [name, digest(await fs.readFile(name))]))),
    scope: 'original compiled Janitor/State and private real FS at controlled existing await boundaries; no deployment, public latency, or asynchronous destruction claim',
    actualApplicationDeploymentVerified: false, performanceVerified: false, asyncFilesystemIsolationVerified: false,
    checks: [], isolatedFilesRemoved: false };
  try {
    report.stage = 'fixed-original-source-preparation';
    execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', referenceHead, inheritedCandidateHead], { stdio: 'pipe', timeout: 120000 });
    const changed = execFileSync('/usr/bin/git', ['diff', '--name-only', referenceHead, inheritedCandidateHead, '--', ':(top)cds/src'],
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    report.inheritedCandidateHead = inheritedCandidateHead;
    report.inheritedProductionSources = changed;
    assert.deepEqual(changed, ['cds/src/executor/routes.ts', 'cds/src/routes/branches.ts',
      'cds/src/routes/legacy-cleanup.ts', 'cds/src/routes/remote-hosts.ts', 'cds/src/services/container.ts',
      'cds/src/services/github-webhook-dispatcher.ts', 'cds/src/services/isolated-shell-executor.ts',
      'cds/src/services/janitor.ts', 'cds/src/services/orphan-worktree.ts', 'cds/src/services/state.ts',
      'cds/src/services/worktree-directory-removal-process.ts', 'cds/src/services/worktree-path-activity.ts',
      'cds/src/services/worktree.ts', 'cds/src/types.ts']);
    report.changedProductionSources = execFileSync('/usr/bin/git', ['diff', '--name-only', inheritedCandidateHead, report.head, '--', ':(top)cds/src'],
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(report.changedProductionSources, currentSourceChanges.map(name => `cds/${name}`).sort());
    const manifestsChanged = execFileSync('/usr/bin/git', ['diff', '--name-only', referenceHead, report.head, '--',
      ':(top)cds/package.json', ':(top)cds/pnpm-lock.yaml'], { encoding: 'utf8' }).trim();
    report.referenceDependencyManifestsChanged = manifestsChanged;
    assert.equal(manifestsChanged, '');
    const referenceRuntime = path.join(temp, 'reference-runtime');
    await fs.cp(path.resolve('dist'), referenceRuntime, { recursive: true });
    await fs.writeFile(path.join(referenceRuntime, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
    await fs.symlink(path.resolve('node_modules'), path.join(referenceRuntime, 'node_modules'), 'dir');
    report.referenceSourceHashes = {};
    for (const name of ['janitor', 'worktree', 'orphan-worktree', 'state']) {
      const original = execFileSync('/usr/bin/git', ['show', `${referenceHead}:cds/src/services/${name}.ts`]);
      report.referenceSourceHashes[`src/services/${name}.ts`] = digest(original);
      const compiled = ts.transpileModule(original.toString('utf8'), { fileName: `${name}.ts`, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, useDefineForClassFields: true,
          newLine: ts.NewLineKind.LineFeed, sourceMap: true, removeComments: false } });
      assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
      await fs.writeFile(path.join(referenceRuntime, `services/${name}.js`), compiled.outputText, { mode: 0o600 });
      await fs.writeFile(path.join(referenceRuntime, `services/${name}.js.map`), compiled.sourceMapText!, { mode: 0o600 });
      if (name === 'janitor') { report.referenceSourceHash = digest(original); report.referenceCompiledJanitorHash = digest(compiled.outputText); }
    }
    report.compilerVersion = ts.version;
    report.currentActivityCompiledHash = digest(await fs.readFile('dist/services/worktree-path-activity.js'));
    const runtimePaths = ['services/janitor.js', 'services/state.js', 'services/orphan-worktree.js',
      'services/worktree.js', 'infra/state-store/json-backing-store.js'];
    report.compiledRuntimeHashes = Object.fromEntries(await Promise.all(runtimePaths.map(async name => [name, digest(await fs.readFile(path.join('dist', name)))])));
    report.referenceCompiledRuntimeHashes = Object.fromEntries(await Promise.all(runtimePaths.map(async name => [name, digest(await fs.readFile(path.join(referenceRuntime, name)))])));
    const oldJanitor = await import(pathToFileURL(path.join(referenceRuntime, 'services/janitor.js')).href);
    const oldState = await import(pathToFileURL(path.join(referenceRuntime, 'services/state.js')).href);
    const newJanitor = await import(new URL('../dist/services/janitor.js', import.meta.url).href);
    const newState = await import(new URL('../dist/services/state.js', import.meta.url).href);
    report.referenceEnumeration = await probeEnumerationYield(oldJanitor, path.join(temp, 'cds-orphan-recheck-original'));
    report.candidateEnumeration = await probeEnumerationYield(newJanitor, path.join(temp, 'cds-orphan-recheck-candidate'));
    assert.equal(report.referenceEnumeration.ticksDuringEnumeration, 0);
    assert.ok(report.candidateEnumeration.ticksDuringEnumeration > 0);
    report.asyncEnumerationYieldVerified = true;
    report.checks.push({ name: 'real-filesystem-enumeration-yields-control', passed: true });
    report.referenceCases = []; report.candidateCases = [];
    const cases: RecheckCase[] = ['claim-during-stat', 'claim-during-previous-remove', 'claim-real-during-stat'];
    for (const scenario of cases) {
      report.stage = `original-${scenario}`;
      const originalResult = await runOrphanRecheckProbe(oldJanitor, oldState, path.join(temp, 'cds-orphan-recheck-original'), scenario);
      report.referenceCases.push(originalResult); assert.equal(originalResult.markerSurvived, false);
      report.stage = `candidate-${scenario}`;
      const candidate = await runOrphanRecheckProbe(newJanitor, newState, path.join(temp, 'cds-orphan-recheck-candidate'), scenario);
      report.candidateCases.push(candidate); assert.equal(candidate.markerSurvived, true);
      assert.equal(candidate.removed.length, 1); assert.match(candidate.keptReason || '', /台账/);
      assert.deepEqual(candidate.errors, []); assert.equal(candidate.actualStateClaimConfirmed, true);
      report.checks.push({ name: scenario, passed: true });
    }
    report.stage = 'fixed-ownership-original-source-preparation';
    execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', ownershipReferenceHead], { stdio: 'pipe', timeout: 120000 });
    report.ownershipReferenceHead = ownershipReferenceHead;
    report.ownershipReferenceSourceHashes = {};
    const ownershipReferenceRuntime = path.join(temp, 'ownership-reference-runtime');
    await fs.cp(path.resolve('dist'), ownershipReferenceRuntime, { recursive: true });
    await fs.writeFile(path.join(ownershipReferenceRuntime, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
    await fs.symlink(path.resolve('node_modules'), path.join(ownershipReferenceRuntime, 'node_modules'), 'dir');
    for (const name of ['janitor', 'worktree', 'orphan-worktree', 'state']) {
      const original = execFileSync('/usr/bin/git', ['show', `${ownershipReferenceHead}:cds/src/services/${name}.ts`]);
      report.ownershipReferenceSourceHashes[`src/services/${name}.ts`] = digest(original);
      const compiled = ts.transpileModule(original.toString('utf8'), { fileName: `${name}.ts`, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, useDefineForClassFields: true,
          newLine: ts.NewLineKind.LineFeed, sourceMap: true, removeComments: false } });
      assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
      await fs.writeFile(path.join(ownershipReferenceRuntime, `services/${name}.js`), compiled.outputText, { mode: 0o600 });
      await fs.writeFile(path.join(ownershipReferenceRuntime, `services/${name}.js.map`), compiled.sourceMapText!, { mode: 0o600 });
    }
    report.ownershipReferenceCompiledRuntimeHashes = Object.fromEntries(await Promise.all(runtimePaths.map(async name => [name, digest(await fs.readFile(path.join(ownershipReferenceRuntime, name)))])));
    const ownershipOldJanitor = await import(pathToFileURL(path.join(ownershipReferenceRuntime, 'services/janitor.js')).href);
    const ownershipOldState = await import(pathToFileURL(path.join(ownershipReferenceRuntime, 'services/state.js')).href);
    const oldWorktree = await import(pathToFileURL(path.join(ownershipReferenceRuntime, 'services/worktree.js')).href);
    const newWorktree = await import(new URL('../dist/services/worktree.js', import.meta.url).href);
    const { IsolatedShellExecutor } = await import(new URL('../dist/services/isolated-shell-executor.js', import.meta.url).href);
    const { ShellExecutor } = await import(new URL('../dist/services/shell-executor.js', import.meta.url).href);
    const shell = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2,
      maxQueued: 4, maxBytes: 256 * 1024, reservedCleanup: 1, reservedCleanupBytes: 64 * 1024 });
    report.ownershipReferenceCases = []; report.ownershipCandidateCases = [];
    const ownershipRoot = path.join(temp, 'cds-orphan-ownership-comparison'); await fs.mkdir(ownershipRoot);
    try {
      await shell.start();
      report.ownershipShellBefore = shell.getStats();
      for (const scenario of ['create-before-state', 'directory-replaced', 'alias-retargeted'] as OwnershipCase[]) {
        const oldRoot = path.join(ownershipRoot, 'cds-orphan-ownership-original');
        const newRoot = path.join(ownershipRoot, 'cds-orphan-ownership-candidate');
        await fs.mkdir(oldRoot, { recursive: true }); await fs.mkdir(newRoot, { recursive: true });
        report.stage = `original-ownership-${scenario}`;
        const original = await runOrphanOwnershipProbe(ownershipOldJanitor, ownershipOldState, oldWorktree, shell, oldRoot, scenario);
        report.ownershipReferenceCases.push(original); assert.equal(original.protectedDuringOperation, false);
        report.stage = `candidate-ownership-${scenario}`;
        const candidate = await runOrphanOwnershipProbe(newJanitor, newState, newWorktree, shell, newRoot, scenario);
        report.ownershipCandidateCases.push(candidate); assert.equal(candidate.protectedDuringOperation, true);
        assert.equal(original.noStateClaim, true); assert.equal(candidate.noStateClaim, true);
        assert.deepEqual(candidate.removed, []); assert.deepEqual(candidate.errors, []); assert.ok(candidate.keptReason);
        report.checks.push({ name: `ownership-${scenario}`, passed: true });
      }
    } finally {
      await shell.close(); report.ownershipShellAfter = shell.getStats();
      const pids = [...new Set([report.ownershipShellBefore?.supervisorPid, report.ownershipShellBefore?.factoryPid,
        ...(report.ownershipShellBefore?.actors || []).map((actor: { pid: number }) => actor.pid)].filter(Boolean))];
      report.ownershipClosedProcessStates = pids.map((pid: number) => {
        let state = ''; try { state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); } catch {}
        assert.ok(!state || state.startsWith('Z')); return { pid, state };
      });
      report.ownershipShellClosed = true;
    }
    report.creationGuardScope = 'all WorktreeService instances within one control process; no cross-process or external mutation exclusivity claim';
    report.asyncDestructionVerified = false;
    report.verdict = 'passed';
  } catch (error) { report.failure = { name: error instanceof Error ? error.name : 'Error' }; throw error; }
  finally {
    await fs.rm(temp, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.name : 'Error'); process.exitCode = 1; });
