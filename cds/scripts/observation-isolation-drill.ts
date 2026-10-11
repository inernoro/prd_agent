import express from 'express';
import { AsyncStuckDeployReconciler } from '../src/services/async-stuck-deploy-reconciler.js';
import { createReleaseGitRunner } from '../src/services/release-git-reader.js';
import { resolveArtifactCommitIdentity } from '../src/services/artifact-commit-identity.js';
import { BranchOperationCoordinator } from '../src/services/branch-operation-coordinator.js';
import { createCdsSystemDiagnosticsRouter } from '../src/routes/cds-system-diagnostics.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ContainerLogStreamHub } from '../src/services/container-log-stream-hub.js';
import { serveContainerLogStream } from '../src/services/container-log-stream-response.js';
import { ssePendingBudget } from '../src/services/bounded-sse-writer.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { IsolatedShellExecutor } from '../src/services/isolated-shell-executor.js';
import { ContainerService, resolveEffectiveProfile } from '../src/services/container.js';
import { captureDeploymentInput, deploymentInputBranch } from '../src/services/deployment-input.js';
import { collectContainerDiagnostics, DockerEventMonitor } from '../src/services/container-diagnostics.js';
import { createJanitorDockerAdapters } from '../src/services/janitor.js';
import { InfraLifecycleWatcher, setReplicaMemberDeathListener } from '../src/services/infra-lifecycle-watcher.js';
import { ObservationStreamExecutor } from '../src/services/observation-stream-executor.js';
import { shellQuoteArg } from '../src/services/secure-database-cli.js';
import { SystemLogMonitor } from '../src/services/system-log-monitor.js';
import { ReleaseCommitClock } from '../src/services/release-commit-clock.js';
import { ReleaseCommitRailReader } from '../src/services/release-commit-rail.js';
import type { CdsConfig, IShellExecutor, BranchEntry, BuildProfile } from '../src/types.js';

const sourcePaths = ['src/services/artifact-commit-identity.ts', 'src/services/artifact-admission.ts', 'src/services/artifact-admission-wait.ts', 'src/services/branch-operation-coordinator.ts', 'src/services/deployment-input.ts', 'src/services/async-stuck-deploy-reconciler.ts', 'src/services/deploy-stuck-reconciler.ts', 'src/services/change-impact-analyzer.ts', 'src/routes/cds-system-diagnostics.ts', 'src/services/preview-instance.ts', 'src/services/release-git-reader.ts', 'src/services/release-commit-clock.ts', 'src/services/release-commit-rail.ts', 'src/routes/releases.ts', 'src/server.ts', 'src/services/system-log-monitor.ts', 'src/services/isolated-shell-executor.ts', 'src/services/observation-stream-executor.ts', 'src/services/docker-observation-event-stream.ts', 'src/services/container-log-stream-hub.ts', 'src/services/container-log-stream-response.ts', 'src/services/bounded-log-tail.ts', 'src/services/bounded-sse-writer.ts', 'src/routes/branches.ts', 'src/services/infra-lifecycle-watcher.ts', 'src/services/observation-process.ts', 'src/services/observation-executor-process.ts', 'src/services/observation-process-launcher.ts', 'src/services/observation-process-group.ts', 'src/services/shell-executor.ts', 'src/services/janitor.ts', 'src/services/secure-database-cli.ts', 'src/services/container.ts', 'src/services/container-diagnostics.ts', 'src/index.ts', 'src/types.ts'];
async function main(): Promise<void> {
  // 只允许本次 GitHub 隔离宿主，不能用于 SSH 或共享 CDS 宿主。
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(os.platform(), 'linux');
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const host = 'unix:///var/run/docker.sock';
  const docker = (args: string[]): string => execFileSync('docker', ['--host', host, ...args], { encoding: 'utf8', timeout: 120000 }).trim();
  const owner = `cds_observe_${randomBytes(8).toString('hex')}`;
  const name = `cds-infra-${owner}-app`;
  const output = path.resolve('observation-output');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-observe-ci-'));
  await fs.chmod(temp, 0o700);
  const compiled = process.argv.includes('--compiled');
  const module = compiled ? await import(new URL('../dist/services/isolated-shell-executor.js', import.meta.url).href) as typeof import('../src/services/isolated-shell-executor.js') : { IsolatedShellExecutor };
  const previousHost = process.env.DOCKER_HOST;
  const previousContext = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = host;
  const operationShell = new module.IsolatedShellExecutor(new ShellExecutor(), {
    isolatedLane: 'operation', concurrency: 3, reservedCleanup: 1, maxQueued: 4, maxBytes: 256 * 1024,
    reservedCleanupBytes: 64 * 1024, defaultTimeoutMs: 15_000,
  });
  const shell = new module.IsolatedShellExecutor(operationShell, { concurrency: 2, maxQueued: 16 });
  const streamModule = compiled ? await import(new URL('../dist/services/observation-stream-executor.js', import.meta.url).href) as typeof import('../src/services/observation-stream-executor.js') : { ObservationStreamExecutor };
  const startupStreams = new streamModule.ObservationStreamExecutor(2);
  const eventStreams = new streamModule.ObservationStreamExecutor(2);
  const userLogStreams = new streamModule.ObservationStreamExecutor(2);
  const journalStreams = new streamModule.ObservationStreamExecutor(1);
  const journalModule = compiled ? await import(new URL('../dist/services/system-log-monitor.js', import.meta.url).href) as typeof import('../src/services/system-log-monitor.js') : { SystemLogMonitor };
  let journalMonitor: SystemLogMonitor | undefined;
  const logHubModule = compiled ? await import(new URL('../dist/services/container-log-stream-hub.js', import.meta.url).href) as typeof import('../src/services/container-log-stream-hub.js') : { ContainerLogStreamHub };
  const userLogHub = new logHubModule.ContainerLogStreamHub(userLogStreams);
  const logResponseModule = compiled ? await import(new URL('../dist/services/container-log-stream-response.js', import.meta.url).href) as typeof import('../src/services/container-log-stream-response.js') : { serveContainerLogStream };
  const logWriterModule = compiled ? await import(new URL('../dist/services/bounded-sse-writer.js', import.meta.url).href) as typeof import('../src/services/bounded-sse-writer.js') : { ssePendingBudget };
  let logServer: http.Server | undefined;
  const logRequests: http.ClientRequest[] = [];
  const archivedLogBytes: number[] = [];
  const diagnosticsModule = compiled ? await import(new URL('../dist/services/container-diagnostics.js', import.meta.url).href) as typeof import('../src/services/container-diagnostics.js') : { collectContainerDiagnostics, DockerEventMonitor };
  const infraModule = compiled ? await import(new URL('../dist/services/infra-lifecycle-watcher.js', import.meta.url).href) as typeof import('../src/services/infra-lifecycle-watcher.js') : { InfraLifecycleWatcher, setReplicaMemberDeathListener };
  const managedActions: string[] = [];
  const eventWarnings: string[] = [];
  const eventStore = { record: (record: { action?: string; message?: string }) => { if (record.action?.includes('warning') && eventWarnings.length < 10) eventWarnings.push((record.message || '').slice(0, 200)); } };
  const dockerEvents = new diagnosticsModule.DockerEventMonitor(shell, eventStore, event => {
    if (event.containerName === name && event.attrs['cds.acceptance.owner'] === owner && managedActions.length < 20) managedActions.push(event.action);
  }, eventStreams);
  const infraEvents = new infraModule.InfraLifecycleWatcher({ streams: eventStreams, serverEventLogStore: eventStore });
  const containerModule = compiled ? await import(new URL('../dist/services/container.js', import.meta.url).href) as typeof import('../src/services/container.js') : { ContainerService, resolveEffectiveProfile };
  const container = new containerModule.ContainerService(shell, { repoRoot: temp, worktreeBase: temp, dockerNetwork: 'bridge', sharedEnv: {}, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'isolated' } } as CdsConfig, undefined, undefined, startupStreams, userLogHub);
  const report: Record<string, any> = {
    schema: 1, startedAt: new Date().toISOString(), head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]))),
    mode: compiled ? 'compiled' : 'source', scope: 'independent bounded observation processes and real owned Docker reads; no application deployment or public performance acceptance',
    actualDockerReadVerified: false, actualIndependentProcessesVerified: false, actualDeploymentVerified: false, performanceVerified: false,
    verdict: 'failed', checks: [], ownedContainerRemoved: false, isolatedFilesRemoved: false,
  };
  let id: string | undefined;
  let masterState: Buffer | undefined;
  const owned = (): void => {
    assert.match(id || '', /^[a-f0-9]{64}$/);
    const view = JSON.parse(docker(['inspect', id!]))[0];
    assert.equal(view.Name, `/${name}`);
    assert.equal(view.Config.Labels['cds.acceptance.owner'], owner);
    assert.equal(view.Config.Image, 'alpine:3.20');
    assert.deepEqual(view.Config.Cmd, ['sh', '-c', 'echo owned-observation; sleep 300']);
    assert.equal(view.HostConfig.NanoCpus, 250000000);
    assert.equal(view.HostConfig.Memory, 67108864);
    assert.equal(view.HostConfig.NetworkMode, 'none');
    if (report.stage !== 'create-owned-container') {
      assert.ok(view.Mounts.some((mount: any) => mount.Type === 'bind' && mount.Source === path.join(temp, 'mounted') && mount.Destination === '/owned-readonly' && mount.RW === false));
    }
    report.containerReceipts ??= [];
    report.containerReceipts.push({ stage: report.stage, id, name, owner, image: view.Config.Image,
      nanoCpus: view.HostConfig.NanoCpus, memory: view.HostConfig.Memory, networkMode: view.HostConfig.NetworkMode });
  };
  try {
    report.stage = 'compiled-explicit-artifact-target-snapshot';
    const inputModule = compiled ? await import(new URL('../dist/services/deployment-input.js', import.meta.url).href) as typeof import('../src/services/deployment-input.js') : { captureDeploymentInput, deploymentInputBranch };
    const previous = 'a'.repeat(40), requested = 'b'.repeat(40);
    const artifactBranch: BranchEntry = { id: 'owned-artifact-target', projectId: 'owned', branch: 'owned-artifact-target', status: 'running', services: {}, worktreePath: temp,
      createdAt: new Date().toISOString(), githubCommitSha: previous, ciTargetSha: previous };
    const artifactProfile: BuildProfile = { id: 'owned-api', projectId: 'owned', name: 'Owned API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}', prebuiltImage: true, containerPort: 8080, workDir: '.', command: '' };
    const pinned = inputModule.captureDeploymentInput(artifactBranch, [artifactProfile], {}, undefined, requested);
    const pinnedImage = containerModule.resolveEffectiveProfile(artifactProfile, inputModule.deploymentInputBranch(pinned, artifactBranch)).dockerImage;
    const unpinned = inputModule.captureDeploymentInput({ ...artifactBranch, githubCommitSha: 'c'.repeat(40) }, [artifactProfile], {});
    const unpinnedImage = containerModule.resolveEffectiveProfile(artifactProfile, inputModule.deploymentInputBranch(unpinned, artifactBranch)).dockerImage;
    assert.equal(pinnedImage, `ghcr.io/owned/api:sha-${requested}`);
    assert.equal(unpinnedImage, `ghcr.io/owned/api:sha-${previous}`);
    assert.equal(artifactBranch.ciTargetSha, previous);
    report.artifactTarget = { scope: 'compiled private snapshot and effective-profile target resolution; no registry admission or application deployment', requested, previous, pinnedImage, unpinnedImage, originalBranchUnchanged: true };
    report.checks.push({ name: 'compiled-explicit-artifact-target-and-unpinned-ci-contract', passed: true });
    report.stage = 'independent-process-prewarm';
    await Promise.all([operationShell.start(), shell.start(), startupStreams.start(), eventStreams.start(), userLogStreams.start(), journalStreams.start()]);
    report.streamWarmStats = startupStreams.getStats();
    report.eventWarmStats = eventStreams.getStats();
    report.userLogWarmStats = userLogStreams.getStats();
    report.journalWarmStats = journalStreams.getStats();
    const warmStats = shell.getStats();
    assert.ok(warmStats.factoryPid && warmStats.factoryPid !== process.pid);
    assert.equal(warmStats.actors.length, 2);
    assert.ok(warmStats.actors.every(actor => actor.pid !== process.pid && actor.pid !== warmStats.factoryPid));
    // 仅专用 CI 中持有有界大状态；验证查询执行进程并不共享 Master 地址空间。
    masterState = Buffer.alloc(256 * 1024 * 1024, 0x31);
    const parent = await shell.exec(`exec '${process.execPath.replace(/'/g, "'\\''")}' -e 'console.log(process.ppid)'`, { executionLane: 'observation', timeout: 5000 });
    const parentPid = Number(parent.stdout.trim());
    assert.ok(shell.getStats().actors.some(actor => actor.pid === parentPid));
    assert.notEqual(parentPid, process.pid);
    const masterRss = process.memoryUsage().rss;
    assert.ok(shell.getStats().actors.every(actor => actor.rss && actor.rss < masterRss && actor.heapLimit && actor.heapLimit <= 192 * 1024 * 1024));
    report.processIsolation = { masterPid: process.pid, masterRss, retainedStateBytes: masterState.length, warmStats, afterQuery: shell.getStats(), queryParentPid: parentPid };
    report.actualIndependentProcessesVerified = true;
    report.checks.push({ name: 'large-master-independent-query-parent-and-bounded-actor-memory', passed: true });

    report.stage = 'compiled-owned-release-git-read';
    const commitClockModule = compiled ? await import(new URL('../dist/services/release-commit-clock.js', import.meta.url).href) as typeof import('../src/services/release-commit-clock.js') : { ReleaseCommitClock };
    const commitRailModule = compiled ? await import(new URL('../dist/services/release-commit-rail.js', import.meta.url).href) as typeof import('../src/services/release-commit-rail.js') : { ReleaseCommitRailReader };
    const releaseRepo = path.join(temp, 'release-git-owned');
    await fs.mkdir(releaseRepo, { mode: 0o700 });
    const setupGit = async (...args: string[]): Promise<string> => {
      const result = await operationShell.exec(['git', '-C', releaseRepo, ...args].map(shellQuoteArg).join(' '), { timeout: 5000 });
      assert.equal(result.exitCode, 0); return result.stdout.trim();
    };
    await setupGit('init', '-q');
    await setupGit('config', 'user.email', 'owned@example.test');
    await setupGit('config', 'user.name', 'Owned Git Probe');
    await fs.mkdir(path.join(releaseRepo, 'cds/web/src'), { recursive: true });
    const ownedRuntimeFile = path.join(releaseRepo, 'cds/web/src/owned.tsx');
    await fs.writeFile(ownedRuntimeFile, 'export const ownedVersion = 1;');
    await fs.writeFile(path.join(releaseRepo, 'owned.txt'), 'first');
    await setupGit('add', '.'); await setupGit('commit', '-qm', '自有第一版');
    const firstCommit = await setupGit('rev-parse', 'HEAD');
    await fs.writeFile(ownedRuntimeFile, 'export const ownedVersion = 2;');
    await fs.writeFile(path.join(releaseRepo, 'owned.txt'), 'second');
    await setupGit('add', '.'); await setupGit('commit', '-qm', '自有第二版');
    const latestCommit = await setupGit('rev-parse', 'HEAD');
    await setupGit('update-ref', 'refs/remotes/origin/main', latestCommit);
    const commitClock = new commitClockModule.ReleaseCommitClock({ shell });
    const commitRail = new commitRailModule.ReleaseCommitRailReader({ shell, repoRootResolver: () => releaseRepo });
    assert.ok(await commitClock.remember(owner, latestCommit, releaseRepo));
    assert.equal(commitClock.getMeta(owner, latestCommit)?.subject, '自有第二版');
    const input = { projectId: owner, branch: 'main', targets: [{ targetId: 'owned', commitSha: firstCommit }] };
    const [railRead, sharedRead] = await Promise.all([commitRail.read(input), commitRail.read(input)]);
    assert.strictEqual(railRead, sharedRead);
    assert.equal(railRead.rail.nodes[0].sha, latestCommit);
    assert.equal(railRead.positions.owned.behindCount, 1);
    assert.equal(railRead.positions.owned.aheadCount, 0);
    assert.equal(await commitRail.countCommitsBetween(owner, firstCommit, latestCommit), 1);
    assert.equal(await commitRail.countCommitsBetween(owner, 'HEAD', latestCommit), null);
    assert.equal(shell.getStats().active, 0);
    report.releaseGit = { firstCommit, latestCommit, changedPaths: (await setupGit('diff', '--name-only', `${firstCommit}..${latestCommit}`, '--')).split('\n'), observedCommit: railRead.rail.nodes[0].sha,
      behindCount: railRead.positions.owned.behindCount, aheadCount: railRead.positions.owned.aheadCount,
      sharedRead: railRead === sharedRead, afterReads: shell.getStats(),
      scope: 'owned real local Git repository through compiled readers and existing process pool; not public release HTTP or complete synchronous filesystem removal' };
    report.checks.push({ name: 'compiled-owned-release-git-metadata-rail-and-unknown-contract', passed: true });

    report.stage = 'compiled-owned-artifact-short-identity';
    const identityModule = compiled ? await import(new URL('../dist/services/artifact-commit-identity.js', import.meta.url).href) as typeof import('../src/services/artifact-commit-identity.js') : { resolveArtifactCommitIdentity };
    const coordinatorModule = compiled ? await import(new URL('../dist/services/branch-operation-coordinator.js', import.meta.url).href) as typeof import('../src/services/branch-operation-coordinator.js') : { BranchOperationCoordinator };
    const targetCoordinator = new coordinatorModule.BranchOperationCoordinator();
    const targetRequest = { projectId: owner, branchId: owner + '-target', kind: 'deploy' as const, trigger: 'manual' as const,
      commitSha: firstCommit.slice(0, 7), commitPinned: true };
    const targetRead = targetCoordinator.beginArtifactTargetRead(targetRequest);
    const resolvedTarget = await identityModule.resolveArtifactCommitIdentity(shell, releaseRepo, targetRequest.commitSha.toUpperCase(), targetRead.assertCurrent);
    assert.equal(resolvedTarget, firstCommit); assert.equal(await setupGit('rev-parse', 'HEAD'), latestCommit);
    assert.equal(await setupGit('status', '--porcelain'), ''); targetRead.release();
    const cancelledRead = targetCoordinator.beginArtifactTargetRead(targetRequest);
    targetCoordinator.cancelBranch(targetRequest.branchId, '自有停止');
    await assert.rejects(identityModule.resolveArtifactCommitIdentity(shell, releaseRepo, targetRequest.commitSha, cancelledRead.assertCurrent)); cancelledRead.release();
    assert.equal(targetCoordinator.getActiveOperations().length, 0); assert.equal(operationShell.getStats().active, 0);
    report.artifactShortIdentity = { requestedShort: targetRequest.commitSha, resolvedTarget, currentSourceHead: latestCommit,
      sourceHeadUnchanged: true, cancelledReadRejected: true, scope: 'compiled helper and qualification with real owned Git through nonurgent process pool; full application deployment not verified' };
    report.checks.push({ name: 'compiled-real-short-commit-identity-and-cancelled-read', passed: true });

    report.stage = 'compiled-owned-nonurgent-git-health-reservation';
    const gitGate = path.join(temp, 'nonurgent-release');
    const gitMarker = path.join(temp, 'nonurgent-git-producer.json');
    const blockerMarker = path.join(temp, 'nonurgent-blocker-producer.json');
    const gitBin = path.join(temp, 'nonurgent-git-bin'); await fs.mkdir(gitBin, { mode: 0o700 });
    const shim = path.join(gitBin, 'git');
    await fs.writeFile(shim, `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');\nfs.writeFileSync(${JSON.stringify(gitMarker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));\nconst t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(gitGate)}))return;clearInterval(t);const p=cp.spawn('/usr/bin/git',process.argv.slice(2),{stdio:'inherit'});p.on('error',()=>process.exit(1));p.on('close',c=>process.exit(c??1));},10);\n`, { mode: 0o700 });
    const waitProducer = async (file: string): Promise<{ pid: number; ppid: number }> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      throw new Error('Owned nonurgent producer did not start');
    };
    const gitExecutor: IShellExecutor = {
      exec: (command, options) => shell.exec(command, { ...options, env: { PATH: `${gitBin}${path.delimiter}${process.env.PATH}` }, timeout: 10000 }),
      execBackgroundObservation: (command, options) => shell.execBackgroundObservation(command, { ...options, env: { PATH: `${gitBin}${path.delimiter}${process.env.PATH}` }, timeout: 10000 }),
    };
    const slowClock = new commitClockModule.ReleaseCommitClock({ shell: gitExecutor });
    const slowRead = slowClock.remember(owner + '-slow', latestCommit, releaseRepo);
    let normalBlocker: Promise<unknown> | undefined;
    try {
      const gitProducer = await waitProducer(gitMarker);
      assert.equal(shell.getStats().active, 0); assert.equal(operationShell.getStats().active, 1);
      const blockCode = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(blockerMarker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gitGate)})){clearInterval(t);process.exit(0);}},10);`;
      normalBlocker = operationShell.exec(['exec', process.execPath, '-e', blockCode].map(shellQuoteArg).join(' '), { timeout: 10000 });
      void normalBlocker.catch(() => {});
      const blockerProducer = await waitProducer(blockerMarker);
      assert.equal(operationShell.getStats().active, 2);
      const healthCommand = ['exec', process.execPath, '-e', 'console.log(process.ppid)'].map(shellQuoteArg).join(' ');
      const healthResults = await Promise.all([shell.exec(healthCommand, { executionLane: 'observation' }), shell.exec(healthCommand, { executionLane: 'observation' })]);
      assert.ok(healthResults.every(result => result.exitCode === 0 && shell.getStats().actors.some(actor => actor.pid === Number(result.stdout.trim()))));
      const groups: Array<{ pid: number; ppid: number; pgid: number }> = [];
      for (const producer of [gitProducer, blockerProducer]) {
        assert.ok(Number.isSafeInteger(producer.pid) && producer.pid > 1);
        const result = await shell.exec(`ps -p ${producer.pid} -o pgid=`, { executionLane: 'observation' });
        const pgid = Number(result.stdout.trim()); assert.ok(operationShell.getStats().actors.some(actor => actor.pid === pgid));
        groups.push({ ...producer, pgid });
      }
      assert.equal(await slowClock.remember(owner + '-overload', latestCommit, releaseRepo), undefined);
      assert.equal(operationShell.getStats().queued, 0);
      await assert.rejects(shell.execBackgroundObservation('true', { executionPurpose: 'temporary-cleanup' }), { code: 'capacity' });
      const cleanupMarker = path.join(temp, 'nonurgent-owned-cleanup');
      const cleanupResult = await shell.exec(`touch ${shellQuoteArg(cleanupMarker)}`, { executionPurpose: 'temporary-cleanup', timeout: 5000 });
      assert.equal(cleanupResult.exitCode, 0); await fs.access(cleanupMarker);
      assert.equal(operationShell.getStats().active, 2);
      report.nonurgentGit = { producers: groups, ordinaryStatsWhileBlocked: operationShell.getStats(), healthStatsWhileBlocked: shell.getStats(),
        healthDuringGit: true, cleanupDuringGit: true, overloadRemainedUnknown: true, cleanupPurposeCannotBorrowReservation: true,
        fixtureTimeoutMs: 10000, productionGitTimeoutMs: 3000,
        scope: 'owned real Git held by private shim via compiled reader and existing operation pool; two health reads and reserved private cleanup remain available; not application phase fairness, full RSS or public performance acceptance' };
    } finally {
      await fs.writeFile(gitGate, 'release', { mode: 0o600 });
      await Promise.all([slowRead, normalBlocker]);
    }
    assert.equal(slowClock.getMeta(owner + '-slow', latestCommit)?.subject, '自有第二版');
    assert.equal(JSON.parse(await fs.readFile(gitMarker, 'utf8')).pid, report.nonurgentGit.producers[0].pid);
    assert.equal(slowClock.get(owner + '-overload', latestCommit), undefined);
    report.nonurgentGit.expiredReadNeverStarted = true;
    assert.equal(operationShell.getStats().active, 0); assert.equal(operationShell.getStats().bytes, 0);
    report.nonurgentGit.afterReads = operationShell.getStats();
    report.nonurgentGit.closedProducerStates = [];
    for (const producer of report.nonurgentGit.producers) {
      const result = await shell.exec(`ps -p ${producer.pid} -o stat=`, { executionLane: 'observation' });
      assert.match(result.stdout.trim(), /^(Z.*)?$/);
      report.nonurgentGit.closedProducerStates.push({ pid: producer.pid, state: result.stdout.trim() });
    }
    report.checks.push({ name: 'compiled-owned-nonurgent-git-health-and-cleanup-reservation', passed: true });


    report.stage = 'compiled-owned-async-stuck-deploy';
    const stuckModule = compiled ? await import(new URL('../dist/services/async-stuck-deploy-reconciler.js', import.meta.url).href) as typeof import('../src/services/async-stuck-deploy-reconciler.js') : { AsyncStuckDeployReconciler };
    const gitRunnerModule = compiled ? await import(new URL('../dist/services/release-git-reader.js', import.meta.url).href) as typeof import('../src/services/release-git-reader.js') : { createReleaseGitRunner };
    const routerModule = compiled ? await import(new URL('../dist/routes/cds-system-diagnostics.js', import.meta.url).href) as typeof import('../src/routes/cds-system-diagnostics.js') : { createCdsSystemDiagnosticsRouter };
    await fs.rm(gitGate); await fs.rm(gitMarker);
    const oldBranch = { id: owner + '-watchdog', projectId: owner, branch: owner, worktreePath: releaseRepo, services: {}, status: 'running', createdAt: new Date().toISOString(), ciImageStatus: 'ready', ciTargetSha: firstCommit, githubCommitSha: latestCommit } as BranchEntry;
    let currentBranch = oldBranch;
    const currentAlarm = (): string | undefined => currentBranch.ciImageError;
    const life = { ...oldBranch, id: owner + '-lifecycle', ciImageStatus: undefined, status: 'starting', lastDeployStartedAt: '2026-06-27T00:18:00.000Z', lastReadyAt: '2026-06-27T01:01:00.000Z' } as BranchEntry;
    const profiles = [{ id: 'web', activeDeployMode: 'express', deployModes: { express: { prebuilt: true } } }] as unknown as BuildProfile[];
    const reconciler = new stuckModule.AsyncStuckDeployReconciler({ getBranches: () => [currentBranch, life], getOptions: () => ({ getBuildProfiles: () => profiles }), git: gitRunnerModule.createReleaseGitRunner(gitExecutor) });
    const diagnosticApp = express(); diagnosticApp.use('/api', routerModule.createCdsSystemDiagnosticsRouter());
    const diagnosticServer = diagnosticApp.listen(0, '127.0.0.1'); await new Promise<void>(resolve => diagnosticServer.once('listening', resolve));
    let watchdogDone = false; const watchdogRun = reconciler.run().then(() => { watchdogDone = true; });
    let watchdogProducer: { pid: number; ppid: number } | undefined;
    try {
      assert.equal(life.status, 'running');
      watchdogProducer = await waitProducer(gitMarker);
      assert.equal(operationShell.getStats().active, 1); assert.equal(shell.getStats().active, 0);
      const group = await shell.exec(`ps -p ${watchdogProducer.pid} -o pgid=`, { executionLane: 'observation' });
      const pgid = Number(group.stdout.trim()); assert.ok(operationShell.getStats().actors.some(actor => actor.pid === pgid));
      const diagnosticResponse = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: (diagnosticServer.address() as { port: number }).port, path: '/api/cds-system/diagnostics/main-thread' }, response => {
          let data = ''; response.on('data', chunk => { data += chunk; }); response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(data) }); } catch (error) { reject(error); } });
        }); req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Owned watchdog diagnostic timed out')));
      });
      assert.equal(diagnosticResponse.status, 200); assert.ok(diagnosticResponse.body.eventLoop); assert.equal(watchdogDone, false);
      currentBranch = { ...oldBranch, services: {}, githubCommitSha: 'c'.repeat(40) };
      report.watchdogGit = { producer: { ...watchdogProducer, pgid }, diagnosticStatus: diagnosticResponse.status, lifecycleWhileGitHeld: true, diagnosticWhileGitHeld: true, fixtureTimeoutMs: 10000,
        scope: 'compiled watchdog coordinator, real owned Git producer and loopback diagnostic route; fresh branch HEAD applied after read; not whole CDS deployment or public performance acceptance' };
    } finally {
      await fs.writeFile(gitGate, 'release'); await watchdogRun; await new Promise<void>(resolve => diagnosticServer.close(() => resolve()));
    }
    report.stage = 'compiled-owned-async-stuck-deploy-fresh-state';
    assert.equal(oldBranch.ciImageError, undefined); assert.equal(currentBranch.ciImageError, undefined);
    currentBranch.githubCommitSha = latestCommit; await reconciler.run();
    report.stage = 'compiled-owned-async-stuck-deploy-cached-current-alarm';
    report.watchdogGit.cachedCurrentAlarm = currentAlarm() ?? null;
    assert.ok(currentAlarm()?.includes('镜像落后'));
    assert.equal(JSON.parse(await fs.readFile(gitMarker, 'utf8')).pid, watchdogProducer!.pid);
    assert.equal(oldBranch.ciImageError, undefined); assert.equal(operationShell.getStats().active, 0); assert.equal(operationShell.getStats().bytes, 0);
    report.watchdogGit.freshStateRespected = true; report.watchdogGit.cachedEvidenceAppliedToCurrentObject = true; report.watchdogGit.noDuplicateGitForCachedPair = true; report.watchdogGit.afterReads = operationShell.getStats();
    report.checks.push({ name: 'compiled-owned-async-watchdog-lifecycle-diagnostics-and-fresh-state', passed: true });

    report.stage = 'create-owned-container';
    const mountedDir = path.join(temp, 'mounted');
    await fs.mkdir(mountedDir);
    docker(['pull', 'alpine:3.20']);
    id = docker(['run', '-d', '--name', name, '--label', `cds.acceptance.owner=${owner}`, '--label', 'cds.managed=true', '--network', 'none', '--cpus', '0.25', '--memory', '64m', '--mount', `type=bind,source=${mountedDir},target=/owned-readonly,readonly`, 'alpine:3.20', 'sh', '-c', 'echo owned-observation; sleep 300']);
    owned();
    report.stage = 'real-container-reads';
    assert.equal(await container.isRunning(id), true);
    const diagnostics = await diagnosticsModule.collectContainerDiagnostics(shell, id, 20);
    assert.equal((diagnostics.inspect?.state as Record<string, unknown>)?.running, true);
    assert.ok(JSON.stringify(diagnostics.logs).includes('owned-observation'));
    report.checks.push({ name: 'real-container-running-and-diagnostics', passed: true });
    report.stage = 'actual-unlabelled-artifact-rejection';
    const unlabelled = await container.inspectDeploymentArtifacts([{ id: 'owned-app', projectId: 'owned', name: 'Owned app', dockerImage: 'alpine:3.20',
      prebuiltImage: true, command: '', workDir: '.', containerPort: 8080 }], report.head, () => assert.ok(id));
    assert.equal(unlabelled.state, 'waiting'); assert.equal(unlabelled.reason, 'revision-mismatch');
    assert.equal(await container.isRunning(id), true);
    report.artifactAdmissionNegative = { scope: 'compiled checker with real daemon/pull/image inspect; image lacks target OCI revision',
      targetCommitSha: report.head, state: unlabelled.state, reason: unlabelled.reason, ownedContainerRetained: true,
      actualRegistryPublishResumeVerified: false, actualApplicationDeploymentVerified: false };
    report.checks.push({ name: 'compiled-real-unlabelled-artifact-rejected-owned-container-retained', passed: true });
    report.stage = 'real-janitor-reads';
    const janitorModule = compiled ? await import(new URL('../dist/services/janitor.js', import.meta.url).href) as typeof import('../src/services/janitor.js') : { createJanitorDockerAdapters };
    const janitor = janitorModule.createJanitorDockerAdapters(shell);
    const [images, inUseImages, mountedPaths] = await Promise.all([
      janitor.imageDocker.listImages(), janitor.imageDocker.listInUseImages(), janitor.orphanWorktreeFs.listMountedHostPaths(),
    ]);
    assert.ok(images.includes('alpine:3.20'));
    assert.ok(inUseImages.includes('alpine:3.20'));
    assert.ok(Array.isArray(mountedPaths) && mountedPaths.includes(mountedDir));
    owned();
    report.checks.push({ name: 'compiled-janitor-image-reference-and-mount-observations', passed: true });
    report.stage = 'real-janitor-partial-mount-failure';
    // 仅替换此前枚举到的ID清单，实际inspect仍由独立进程调用真实Docker。
    // 一个ID已不存在时会输出另一容器的真实挂载并非零退出，不能视作完整结果。
    let partialReceipt: { exitCode: number; knownMountPresent: boolean } | undefined;
    const partialJanitor = janitorModule.createJanitorDockerAdapters({ exec: async (command, options) => {
      if (command === ['docker', 'ps', '-aq'].map(shellQuoteArg).join(' ')) return { stdout: `${id}\n${'0'.repeat(64)}`, stderr: '', exitCode: 0 };
      const result = await shell.exec(command, options);
      partialReceipt = { exitCode: result.exitCode, knownMountPresent: result.stdout.includes(mountedDir) };
      return result;
    } });
    const partialPaths = await partialJanitor.orphanWorktreeFs.listMountedHostPaths();
    report.partialMountReceipt = { ...partialReceipt, returnedUnknown: partialPaths === null, roster: 'owned ID plus absent ID' };
    assert.equal(partialPaths, null);
    assert.ok(partialReceipt && partialReceipt.exitCode !== 0 && partialReceipt.knownMountPresent);
    report.partialMountReceipt = { ...partialReceipt, returnedUnknown: true, roster: 'owned ID plus absent ID' };
    owned();
    report.checks.push({ name: 'compiled-janitor-real-partial-inspect-protects-unknown-mounts', passed: true });
    report.stage = 'real-startup-log-stream';
    assert.equal(await container.waitForStartupSignal(id!, 'owned-observation', undefined, 5), true);
    assert.equal(startupStreams.getStats().admitted, 0);
    owned();
    report.checks.push({ name: 'compiled-real-startup-signal-cleans-independent-stream', passed: true });
    report.stage = 'uncaptured-large-stream-and-reserved-health-slots';
    let streamBytes = 0;
    let prefix = '';
    const largeStream = await startupStreams.exec(['exec', shellQuoteArg(process.execPath), '-e', shellQuoteArg("process.stdout.write(process.ppid+'\\n');process.stdout.write(Buffer.alloc(12*1024*1024,120));")].join(' '), {
      timeout: 10_000, onData: chunk => { if (!streamBytes) prefix = chunk; streamBytes += Buffer.byteLength(chunk); },
    });
    const streamParent = Number(prefix.split('\n')[0]);
    assert.ok(startupStreams.getStats().actors.some(actor => actor.pid === streamParent));
    assert.notEqual(streamParent, process.pid);
    assert.equal(streamBytes, 12 * 1024 * 1024 + Buffer.byteLength(String(streamParent) + '\n'));
    assert.deepEqual(largeStream, { stdout: '', stderr: '', exitCode: 0 });
    const heldStreams = Array.from({ length: 2 }, () => startupStreams.exec('sleep 0.5', { timeout: 5000, onData: () => {} }));
    await assert.rejects(startupStreams.exec('echo must-not-start', { onData: () => {} }), { code: 'capacity' });
    assert.equal(await container.isRunning(id!), true);
    await Promise.all(heldStreams);
    report.streamReceipt = { bytes: streamBytes, parentPid: streamParent, captureBytes: 0, healthReadableWhileStreamSlotsFull: true, stats: startupStreams.getStats() };
    report.checks.push({ name: 'compiled-large-stream-no-capture-and-health-capacity-preserved', passed: true });
    report.stage = 'real-owned-docker-lifecycle-event-streams';
    dockerEvents.start(); infraEvents.start();
    let observed = false;
    for (let attempt = 0; attempt < 3 && !observed; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      owned(); docker(['stop', '-t', '1', id!]); owned(); docker(['start', id!]); owned();
      for (let wait = 0; wait < 200; wait++) {
        observed = managedActions.includes('die') && infraEvents.getEvents(name).some(event => event.event === 'die');
        if (observed) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    report.eventReceipt = { managedOwnedActions: managedActions, infraOwnedEvents: infraEvents.getEvents(name).map(event => ({ event: event.event, exitCode: event.exitCode, containerId: event.containerId })), warnings: eventWarnings, observed };
    assert.ok(observed);
    assert.ok(infraEvents.getEvents(name).some(event => event.event === 'die' && event.containerId === id), 'actual Docker die must retain its container identity');
    assert.equal(await container.isRunning(id!), true);
    await Promise.all([dockerEvents.stop(), infraEvents.stop()]);
    assert.equal(eventStreams.getStats().admitted, 0);
    report.eventReceipt.drainedStats = eventStreams.getStats();
    report.checks.push({ name: 'compiled-owned-docker-events-independent-streams-and-drain', passed: true });

    report.stage = 'compiled-controlled-oom-correlation-capacity-and-identity';
    let lastDeath = '';
    const correlation = new infraModule.InfraLifecycleWatcher({ serverEventLogStore: { record: row => {
      if (row.action === 'infra.lifecycle.die') lastDeath = row.message ?? '';
    } } });
    const controlled = correlation as unknown as { ingest(line: string): void; recentOom: Map<string, number> };
    const emitOwned = (action: string, containerId: string | undefined, containerName = 'cds-infra-controlled', time = 100) => controlled.ingest(JSON.stringify({ Action: action, time, Actor: { ID: containerId, Attributes: { name: containerName, exitCode: '137' } } }));
    for (let n = 0; n < 600; n++) emitOwned('oom', `owned-${n}`, `cds-infra-owned-${n}`);
    report.oomCorrelation = { scope: 'controlled JSON through compiled watcher; no kernel OOM injection', remembered: controlled.recentOom.size, ring: correlation.getEvents().length };
    assert.equal(controlled.recentOom.size, 400); assert.equal(correlation.getEvents().length, 400);
    emitOwned('die', 'owned-0', 'cds-infra-owned-0', 101); assert.match(lastDeath, /原因待核实/);
    emitOwned('die', 'owned-599', 'cds-infra-owned-599', 101); assert.match(lastDeath, /cgroup OOM kill/);
    emitOwned('oom', 'old-id'); emitOwned('die', 'new-id', undefined, 101); assert.match(lastDeath, /原因待核实/);
    for (const action of ['start', 'restart']) {
      emitOwned('oom', 'restarted'); emitOwned(action, 'restarted', undefined, 101); emitOwned('die', 'restarted', undefined, 102);
      assert.match(lastDeath, /原因待核实/);
    }
    emitOwned('oom', undefined); emitOwned('die', undefined, undefined, 101); assert.match(lastDeath, /原因待核实/);
    const deaths: string[] = [];
    infraModule.setReplicaMemberDeathListener((_name, verdict) => deaths.push(verdict));
    try {
      emitOwned('oom', 'replica', 'cds-owned-web-res-1'); emitOwned('die', 'replica', 'cds-owned-web-res-1', 101);
      emitOwned('oom', 'expired', 'cds-owned-web-res-1'); emitOwned('die', 'expired', 'cds-owned-web-res-1', 111);
      assert.equal(deaths.length, 2); assert.match(deaths[0], /cgroup OOM kill/); assert.match(deaths[1], /原因待核实/);
      assert.equal(controlled.recentOom.size, 0);
    } finally { infraModule.setReplicaMemberDeathListener(null); }
    report.oomCorrelation = { ...report.oomCorrelation, unknownOnEvictionOrMissingIdentity: true, sameNameDifferentIdUnknown: true, restartClearsGeneration: true, replicaDeathNotifications: deaths, finalRemembered: controlled.recentOom.size };
    report.checks.push({ name: 'compiled-controlled-oom-correlation-capacity-identity-and-unknown', passed: true });

    report.stage = 'compiled-owned-oom-continuity-processes';
    const continuityBin = path.join(temp, 'continuity-bin'); await fs.mkdir(continuityBin, { mode: 0o700 });
    await fs.writeFile(path.join(continuityBin, 'docker'), `#!${process.execPath}\nconst fs=require('fs');const mode=process.env.CDS_OWNED_EVENT_MODE;const trace=${JSON.stringify(continuityBin)}+'/'+mode+'.jsonl';const stat=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ');fs.appendFileSync(trace,JSON.stringify({pid:process.pid,ppid:process.ppid,pgid:Number(stat[2])})+'\\n');const count=fs.readFileSync(trace,'utf8').trim().split('\\n').length;const emit=(Action,time)=>JSON.stringify({Action,time,Actor:{ID:'owned-continuity',Attributes:{name:'cds-infra-owned-continuity',exitCode:'137'}}})+'\\n';if((mode==='disconnect'||mode==='stop')&&count===1){process.stdout.write(emit('oom',100));if(mode==='disconnect')setTimeout(()=>process.exit(1),20);}else{if(mode!=='disconnect'&&mode!=='stop'){process.stdout.write(emit('oom',100));if(mode==='overflow')process.stdout.write('x'.repeat(128*1024)+'\\n');if(mode==='malformed')process.stdout.write('{incomplete-json}\\n');}process.stdout.write(emit('die',106)+emit('oom',107)+emit('die',108));}setInterval(()=>{},1000);\n`, { mode: 0o700 });
    report.oomContinuity = { scope: 'compiled watcher and real owned event producers through original stream/IPC; controlled JSON, no kernel OOM injection', modes: [] };
    for (const mode of ['disconnect', 'stop', 'overflow', 'handler', 'malformed']) {
      const records: Array<{ action?: string; message?: string }> = []; const actorPids = new Set<number>(); let failedHandler = false;
      const wrappedStreams = { exec: (command: string, options: Parameters<ObservationStreamExecutor['exec']>[1]) => eventStreams.exec(command, {
        ...options, env: { ...options.env, PATH: `${continuityBin}${path.delimiter}${process.env.PATH}`, CDS_OWNED_EVENT_MODE: mode },
        onData: async (chunk, channel) => { for (const actor of eventStreams.getStats().actors) if (actor.pid) actorPids.add(actor.pid); await options.onData?.(chunk, channel); },
      }) } as ObservationStreamExecutor;
      const watcher = new infraModule.InfraLifecycleWatcher({ streams: wrappedStreams, serverEventLogStore: { record: row => {
        records.push(row);
        if (mode === 'handler' && row.action === 'infra.lifecycle.oom' && !failedHandler) { failedHandler = true; throw new Error('owned OOM handler unconfirmed'); }
      } } });
      const waitFor = async (predicate: () => boolean) => { for (let n = 0; n < 800; n++) { if (predicate()) return; await new Promise(r => setTimeout(r,25)); } throw new Error(`owned OOM continuity ${mode} not observed`); };
      try {
        watcher.start();
        if (mode === 'stop') { await waitFor(() => records.some(r => r.action === 'infra.lifecycle.oom')); await watcher.stop(); watcher.start(); }
        await waitFor(() => records.filter(r => r.action === 'infra.lifecycle.die').length === 2);
        const deaths = records.filter(r => r.action === 'infra.lifecycle.die').map(r => r.message ?? '');
        assert.match(deaths[0], /原因待核实/); assert.doesNotMatch(deaths[0], /cgroup OOM kill/); assert.match(deaths[1], /cgroup OOM kill/);
        await watcher.stop(); assert.equal(eventStreams.getStats().admitted, 0);
        const producers = (await fs.readFile(path.join(continuityBin, `${mode}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(producers.length, mode === 'disconnect' || mode === 'stop' ? 2 : 1);
        assert.ok(producers.every(p => p.ppid !== process.pid && actorPids.has(p.pgid)));
        report.oomContinuity.modes.push({ mode, deaths, producers, actorPids: [...actorPids], drained: true });
      } finally { await watcher.stop(); }
    }
    report.checks.push({ name: 'compiled-owned-oom-gap-stop-overflow-handler-and-malformed-continuity', passed: true });

    report.stage = 'compiled-owned-container-log-http-streams';
    logServer = http.createServer((req, res) => {
      if (req.url !== '/owned-log-stream') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
      logResponseModule.serveContainerLogStream(req as Parameters<typeof serveContainerLogStream>[0], res as Parameters<typeof serveContainerLogStream>[1], {
        containerService: container,
        stateService: { appendContainerLogArchive: (_branch: string, entry: { logs: string }) => { archivedLogBytes.push(Buffer.byteLength(entry.logs)); }, save: () => {} } as unknown as Parameters<typeof serveContainerLogStream>[2]['stateService'],
        branch: { id: owner, projectId: owner, branch: owner, worktreePath: temp, createdAt: new Date().toISOString(), status: 'running', services: {} },
        service: { profileId: 'owned', containerName: id!, hostPort: 0, status: 'running' }, mask: true,
      });
    });
    await new Promise<void>(resolve => logServer!.listen(0, '127.0.0.1', resolve));
    const logPort = (logServer.address() as { port: number }).port;
    const logReceived = Array.from({ length: 100 }, () => false);
    await Promise.all(logReceived.map((_, index) => new Promise<void>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${logPort}/owned-log-stream`, response => {
        try { assert.equal(response.statusCode, 200); assert.ok(response.headers['content-type']?.startsWith('text/event-stream')); }
        catch (error) { response.destroy(); reject(error); return; }
        response.on('error', () => {});
        response.on('data', (chunk: Buffer) => { if (chunk.toString().includes('owned-observation')) logReceived[index] = true; });
        resolve();
      });
      request.on('error', reject); logRequests.push(request);
    })));
    for (let wait = 0; wait < 500 && !logReceived.every(Boolean); wait++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(logReceived.every(Boolean)); assert.equal(userLogHub.getStats().subscribers, 100);
    assert.equal(userLogStreams.getStats().admitted, 1); assert.equal(userLogHub.getStats().readers, 1);
    assert.equal(await container.isRunning(id!), true); owned();
    report.userLogReceipt = { receivedConnections: logReceived.filter(Boolean).length, sharedReaderCount: userLogHub.getStats().readers, healthReadable: true,
      pendingBytes: logWriterModule.ssePendingBudget.bytes, streamStats: userLogStreams.getStats(), scope: 'owned loopback compiled helper; not public browser or 30-minute load acceptance' };
    logRequests.splice(0).forEach(request => request.destroy());
    await new Promise<void>(resolve => logServer!.close(() => resolve())); logServer = undefined;
    await userLogHub.close();
    assert.equal(userLogStreams.getStats().admitted, 0); assert.equal(userLogHub.getStats().subscribers, 0);
    assert.equal(logWriterModule.ssePendingBudget.bytes, 0); assert.equal(archivedLogBytes.length, 100);
    assert.ok(archivedLogBytes.every(bytes => bytes <= 256 * 1024 + 128));
    report.userLogReceipt.drained = { ...userLogHub.getStats(), pendingBytes: logWriterModule.ssePendingBudget.bytes, archiveCount: archivedLogBytes.length, maximumArchiveBytes: Math.max(...archivedLogBytes) };
    report.checks.push({ name: 'compiled-owned-shared-log-http-readers-and-health-capacity', passed: true });

    report.stage = 'compiled-owned-journal-producer';
    let journalVersion = '';
    const journalBinary = await journalStreams.exec(['journalctl', '--version'].map(shellQuoteArg).join(' '), {
      timeout: 8000, onData: chunk => { journalVersion = (journalVersion + chunk).slice(0, 4096); },
    });
    assert.equal(journalBinary.exitCode, 0); assert.match(journalVersion, /systemd/i);
    // 专用合成JSON生产者验证编译类/真实进程与IPC，不冒称已读取真实服务journald。
    const journalBin = path.join(temp, 'journal-bin'); await fs.mkdir(journalBin, { mode: 0o700 });
    const journalTrace = path.join(temp, 'journal-trace.jsonl');
    const journalUnit = `${owner}.service`;
    await fs.writeFile(path.join(journalBin, 'journalctl'), String.raw`#!${process.execPath}
const fs=require('node:fs');const {execFileSync}=require('node:child_process');const args=process.argv.slice(2);
if(!args.includes(${JSON.stringify(journalUnit)})||!args.includes('warning..alert'))process.exit(2);
const pgid=Number(execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim());
fs.appendFileSync(${JSON.stringify(journalTrace)},JSON.stringify({pid:process.pid,ppid:process.ppid,pgid,args})+'\n');
const emit=(cursor,message)=>process.stdout.write(JSON.stringify({__CURSOR:cursor,PRIORITY:'4',MESSAGE:message})+'\n');
emit('owned-shared-cursor','warning owned backfill');
if(args.includes('-f')){process.stdout.write('x'.repeat(128*1024)+'\n');emit('owned-tail-cursor','warning owned tail');setInterval(()=>{},1000);}
`, { mode: 0o700 });
    const realJournalExec = journalStreams.exec.bind(journalStreams);
    journalStreams.exec = (command, options) => realJournalExec(command, { ...options, env: { ...options.env, PATH: `${journalBin}:${process.env.PATH || ''}` } });
    const journalRecords: any[] = [];
    journalMonitor = new journalModule.SystemLogMonitor(shell, { record: record => { journalRecords.push(record); } }, [journalUnit], journalStreams);
    await journalMonitor.start();
    for (let wait = 0; wait < 500 && !journalRecords.some(record => record.action === 'journal.tail'); wait++) await new Promise(resolve => setTimeout(resolve, 10));
    const journalCommands = (await fs.readFile(journalTrace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    report.journalReceipt = { journalBinaryVersion: journalVersion.split('\n')[0], commands: journalCommands, stats: journalMonitor.getStats(),
      streamStats: journalStreams.getStats(), scope: 'owned synthetic journal producer via compiled monitor and real process/IPC; version is actual journalctl binary, not actual service journald contents' };
    report.stage = 'compiled-journal-output-contract';
    assert.ok(journalRecords.some(record => record.action === 'journal.tail'));
    assert.equal(journalMonitor.getStats().overflowLines, 1);
    assert.deepEqual(journalRecords.filter(record => record.action.startsWith('journal.') && record.action !== 'journal.oversize').map(record => record.message), ['warning owned backfill', 'warning owned tail']);
    report.stage = 'compiled-journal-owned-process-group';
    assert.equal(journalCommands.length, 2);
    // /bin/sh可保留中间Shell；独立actor的进程组才是执行与取消归属，不要求生产者是直接子进程。
    assert.ok(journalCommands.every(command => Number.isSafeInteger(command.pgid) && command.pgid > 1 &&
      command.ppid !== process.pid && journalStreams.getStats().actors.some(actor => actor.pid === command.pgid)));
    report.stage = 'compiled-journal-health-and-drain';
    assert.equal(await container.isRunning(id!), true); owned();
    report.journalReceipt.healthReadable = true;
    await journalMonitor.stop(); assert.equal(journalStreams.getStats().admitted, 0); assert.equal(journalMonitor.getStats().bufferedBytes, 0);
    report.journalReceipt.drainedStats = journalStreams.getStats();
    journalStreams.exec = realJournalExec;
    report.checks.push({ name: 'compiled-owned-journal-producer-bounds-and-drain', passed: true });

    report.stage = 'compiled-owned-default-operation-and-qualification';
    const operationProbe = await shell.exec(`exec ${shellQuoteArg(process.execPath)} --eval ${shellQuoteArg("console.log(JSON.stringify({pid:process.pid,ppid:process.ppid}))")}`);
    const operationParent = JSON.parse(operationProbe.stdout);
    assert.notEqual(operationParent.ppid, process.pid);
    assert.ok(operationShell.getStats().actors.some(actor => actor.pid === operationParent.ppid));
    const operationActors = operationShell.getStats().actors.map(actor => actor.pid);
    const operationMarker = path.join(temp, 'operation-must-not-start');
    const operationRelease = path.join(temp, 'release-owned-operations');
    let operationProducersReady = 0;
    const blockedOperation = `exec ${shellQuoteArg(process.execPath)} --eval ${shellQuoteArg(`const fs=require('node:fs');console.log('owned-ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(operationRelease)}))clearInterval(timer)},10);`)}`;
    const operationBlockers = Promise.all(Array.from({ length: 2 }, () => operationShell.exec(blockedOperation, {
      onData: chunk => { if (chunk.includes('owned-ready')) operationProducersReady++; },
    })));
    void operationBlockers.catch(() => {});
    for (let wait = 0; wait < 500 && operationProducersReady < 2; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(operationProducersReady, 2);
    await assert.rejects(operationShell.exec('echo ' + 'x'.repeat(192 * 1024), {
      beforeStart: () => {}, timeout: 100,
    }), (error: any) => error?.code === 'capacity');
    let qualificationChecks = 0;
    const supersededOperation = new Error('owned-operation-superseded');
    const rejectedOperation = operationShell.exec(`touch ${shellQuoteArg(operationMarker)}`, {
      beforeStart: () => { qualificationChecks++; throw supersededOperation; },
    }).then(() => undefined, error => error);
    assert.ok(operationShell.getStats().queued >= 1);
    const retainedOperations = Promise.all(Array.from({ length: 2 }, () => operationShell.exec('echo retained-owned', { beforeStart: () => {} })));
    void retainedOperations.catch(() => {});
    assert.equal(operationShell.getStats().queued, 3);
    await assert.rejects(operationShell.exec('echo extra-must-not-enter', {
      beforeStart: () => {}, timeout: 100,
    }), (error: any) => error?.code === 'capacity');
    const healthDuringOperations = await container.isRunning(id!);
    assert.equal(healthDuringOperations, true);
    assert.equal(operationShell.getStats().active, 2);
    const ownedCleanupMarker = path.join(temp, 'owned-cleanup-started');
    const cleanupDuringOperations = await operationShell.exec(`touch ${shellQuoteArg(ownedCleanupMarker)}`, {
      executionPurpose: 'temporary-cleanup', timeout: 5000,
    });
    assert.equal(cleanupDuringOperations.exitCode, 0); await fs.access(ownedCleanupMarker);
    assert.equal(operationShell.getStats().queued, 3);
    assert.equal(operationShell.getStats().active, 2);
    await fs.writeFile(operationRelease, 'owned-release', { mode: 0o600 });
    await operationBlockers;
    assert.equal(await rejectedOperation, supersededOperation); assert.equal(qualificationChecks, 1);
    assert.ok((await retainedOperations).every(result => result.exitCode === 0));
    await assert.rejects(fs.access(operationMarker), { code: 'ENOENT' });
    assert.deepEqual(operationShell.getStats().actors.map(actor => actor.pid), operationActors);
    owned();
    const operationStop = await shell.exec(['docker', 'stop', '--time', '1', id!].map(shellQuoteArg).join(' '));
    assert.equal(operationStop.exitCode, 0); assert.equal(await container.isRunning(id!), false);
    owned();
    const operationStart = await shell.exec(['docker', 'start', id!].map(shellQuoteArg).join(' '));
    assert.equal(operationStart.exitCode, 0); assert.equal(await container.isRunning(id!), true); owned();
    report.operationReceipt = { actualProducer: operationParent, actorPids: operationActors, qualificationChecks,
      rejectedCommandNeverStarted: true, healthDuringOperations, cleanupDuringOperations: true, queueAdmissionProtected: true,
      byteAdmissionProtected: true, queuedOperationsAtCleanup: 3, actualOwnedStopStart: true, stats: operationShell.getStats(),
      scope: 'compiled default operation process routing and owned Docker stop/start; private queued command rejected before start, not application deployment or stage fairness acceptance' };
    report.checks.push({ name: 'compiled-owned-default-operation-qualified-dispatch-and-health-reservation', passed: true });

    report.stage = 'bounded-read-concurrency';
    const requests = Array.from({ length: 8 }, () => container.isRunning(id!));
    assert.ok(shell.getStats().active <= 2 && shell.getStats().queued >= 6);
    assert.ok((await Promise.all(requests)).every(Boolean));
    report.checks.push({ name: 'eight-real-reads-bounded-concurrency', passed: true });
    report.stage = 'queued-deadline-cancellation';
    const cancel = new AbortController();
    const sentinel = path.join(temp, 'must-not-start');
    const active = [shell.exec('sleep 0.5', { executionLane: 'observation' }), shell.exec('sleep 0.5', { executionLane: 'observation' })];
    const expired = assert.rejects(shell.exec(`touch '${sentinel}'`, { executionLane: 'observation', timeout: 50 }), { code: 'deadline' });
    const cancelled = assert.rejects(shell.exec(`touch '${sentinel}'`, { executionLane: 'observation', signal: cancel.signal }), { code: 'cancelled' });
    cancel.abort();
    await Promise.all([...active, expired, cancelled]);
    await assert.rejects(fs.access(sentinel), { code: 'ENOENT' });
    report.checks.push({ name: 'expired-and-cancelled-never-start', passed: true });
    report.stage = 'active-process-tree-cleanup';
    const pidFile = path.join(temp, 'child.pid');
    const deadline = assert.rejects(shell.exec(`sleep 30 & echo $! > '${pidFile}'; wait`, { executionLane: 'observation', timeout: 500 }), { code: 'deadline' });
    await deadline;
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
    assert.match(state.stdout.trim(), /^(Z.*)?$/);
    assert.equal(await container.isRunning(id), true);
    report.checks.push({ name: 'timeout-process-tree-cleaned-owned-container-retained', passed: true });
    report.processStats = shell.getStats();
    assert.equal(masterState.length, 256 * 1024 * 1024);
    assert.equal(masterState[masterState.length - 1], 0x31);
    report.actualDockerReadVerified = true;
    report.verdict = 'passed';
    report.stage = 'completed';
  } catch (error) {
    report.failure = { name: error instanceof Error ? error.name : 'Error',
      ...(error && typeof error === 'object' && 'code' in error ? { code: String(error.code).slice(0, 100) } : {}) };
    process.exitCode = 1;
  } finally {
    logRequests.splice(0).forEach(request => request.destroy());
    if (logServer) { logServer.closeAllConnections(); await new Promise<void>(resolve => logServer!.close(() => resolve())); }
    try { await Promise.all([dockerEvents.stop(), infraEvents.stop(), userLogHub.close(), journalMonitor?.stop()]); }
    catch { report.verdict = 'failed'; process.exitCode = 1; }
    const processRoots = [operationShell.getStats().factoryPid, ...operationShell.getStats().actors.map(actor => actor.pid), shell.getStats().factoryPid, ...shell.getStats().actors.map(actor => actor.pid), startupStreams.getStats().factoryPid, ...startupStreams.getStats().actors.map(actor => actor.pid), eventStreams.getStats().factoryPid, ...eventStreams.getStats().actors.map(actor => actor.pid), userLogStreams.getStats().factoryPid, ...userLogStreams.getStats().actors.map(actor => actor.pid), journalStreams.getStats().factoryPid, ...journalStreams.getStats().actors.map(actor => actor.pid)].filter((pid): pid is number => !!pid);
    try {
      await Promise.all([operationShell.close(), shell.close(), startupStreams.close(), eventStreams.close(), userLogStreams.close(), journalStreams.close()]);
      report.closedProcessStates = processRoots.map(pid => {
        let state = '';
        try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { /* 不存在退出1 */ }
        assert.match(state, /^(Z.*)?$/);
        return { pid, state };
      });
      report.ownedProcessesRemoved = true;
    } catch { report.verdict = 'failed'; report.ownedProcessesRemoved = false; process.exitCode = 1; }
    masterState = undefined;
    if (id) {
      try { owned(); docker(['rm', '-f', id]); report.ownedContainerRemoved = true; }
      catch { report.verdict = 'failed'; process.exitCode = 1; }
    }
    await fs.rm(temp, { recursive: true, force: true });
    report.isolatedFilesRemoved = true;
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext !== undefined) process.env.DOCKER_CONTEXT = previousContext;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
void main().catch(() => { process.exitCode = 1; });
