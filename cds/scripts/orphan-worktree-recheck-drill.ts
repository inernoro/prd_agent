import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { runOrphanRecheckProbe, probeEnumerationYield, type RecheckCase } from './orphan-worktree-recheck-probe.js';

const referenceHead = 'a64d9b2494c8a0e140dd678c9c4bd9b90e1935c4';
const sources = ['src/services/janitor.ts', 'src/services/state.ts', 'src/services/orphan-worktree.ts',
  'src/services/worktree.ts', 'src/infra/state-store/json-backing-store.ts', 'scripts/orphan-worktree-recheck-drill.ts',
  'scripts/orphan-worktree-recheck-probe.ts', 'tests/services/janitor-orphan-worktree-recheck.test.ts'];
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
    execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', referenceHead], { stdio: 'pipe', timeout: 120000 });
    const changed = execFileSync('/usr/bin/git', ['diff', '--name-only', referenceHead, report.head, '--', 'cds/src'],
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert.deepEqual(changed, ['cds/src/services/janitor.ts']); report.changedProductionSources = changed;
    assert.equal(execFileSync('/usr/bin/git', ['diff', '--name-only', referenceHead, report.head, '--',
      'cds/package.json', 'cds/pnpm-lock.yaml'], { encoding: 'utf8' }).trim(), '');
    const original = execFileSync('/usr/bin/git', ['show', `${referenceHead}:cds/src/services/janitor.ts`]);
    report.referenceSourceHash = digest(original);
    const compiled = ts.transpileModule(original.toString('utf8'), { fileName: 'janitor.ts', reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, useDefineForClassFields: true,
        newLine: ts.NewLineKind.LineFeed, sourceMap: true, removeComments: false } });
    assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
    const referenceRuntime = path.join(temp, 'reference-runtime');
    await fs.cp(path.resolve('dist'), referenceRuntime, { recursive: true });
    await fs.writeFile(path.join(referenceRuntime, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
    // 固定锁文件同一安装依赖，仅链接读取；清理私有目录不会递归删除依赖真身。
    await fs.symlink(path.resolve('node_modules'), path.join(referenceRuntime, 'node_modules'), 'dir');
    await fs.writeFile(path.join(referenceRuntime, 'services/janitor.js'), compiled.outputText, { mode: 0o600 });
    await fs.writeFile(path.join(referenceRuntime, 'services/janitor.js.map'), compiled.sourceMapText!, { mode: 0o600 });
    report.referenceCompiledJanitorHash = digest(compiled.outputText); report.compilerVersion = ts.version;
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
    report.verdict = 'passed';
  } catch (error) { report.failure = { name: error instanceof Error ? error.name : 'Error' }; throw error; }
  finally {
    await fs.rm(temp, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.name : 'Error'); process.exitCode = 1; });
