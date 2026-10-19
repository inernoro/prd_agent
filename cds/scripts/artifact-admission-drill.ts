import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BranchEntry, BuildProfile, CdsConfig } from '../src/types.js';
import type { ArtifactAdmission } from '../src/services/artifact-admission.js';

const value = (name: string): string => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] || '' : ''; };
const modules = async () => ({
  branches: await import(new URL('../dist/routes/branches.js', import.meta.url).href) as typeof import('../src/routes/branches.js'),
  registry: await import(new URL('../dist/scheduler/executor-registry.js', import.meta.url).href) as typeof import('../src/scheduler/executor-registry.js'),
  executor: await import(new URL('../dist/executor/routes.js', import.meta.url).href) as typeof import('../src/executor/routes.js'),
  worktree: await import(new URL('../dist/services/worktree.js', import.meta.url).href) as typeof import('../src/services/worktree.js'),
  state: await import(new URL('../dist/services/state.js', import.meta.url).href) as typeof import('../src/services/state.js'),
  runs: await import(new URL('../dist/services/deployment-run.js', import.meta.url).href) as typeof import('../src/services/deployment-run.js'),
  coordinator: await import(new URL('../dist/services/branch-operation-coordinator.js', import.meta.url).href) as typeof import('../src/services/branch-operation-coordinator.js'),
  input: await import(new URL('../dist/services/deployment-input.js', import.meta.url).href) as typeof import('../src/services/deployment-input.js'),
  wait: await import(new URL('../dist/services/artifact-admission-wait.js', import.meta.url).href) as typeof import('../src/services/artifact-admission-wait.js'),
  artifacts: await import(new URL('../dist/services/artifact-admission.js', import.meta.url).href) as typeof import('../src/services/artifact-admission.js'),
  container: await import(new URL('../dist/services/container.js', import.meta.url).href) as typeof import('../src/services/container.js'),
  shell: await import(new URL('../dist/services/shell-executor.js', import.meta.url).href) as typeof import('../src/services/shell-executor.js'),
  isolated: await import(new URL('../dist/services/isolated-shell-executor.js', import.meta.url).href) as typeof import('../src/services/isolated-shell-executor.js'),
  versions: await import(new URL('../dist/services/deployment-version.js', import.meta.url).href) as typeof import('../src/services/deployment-version.js'),
});
const sourcePaths = ['src/routes/branches.ts', 'src/scheduler/executor-registry.ts', 'src/services/artifact-admission.ts', 'src/services/artifact-admission-wait.ts',
  'src/services/branch-operation-coordinator.ts', 'src/services/deployment-input.ts', 'src/services/deployment-intent.ts',
  'src/services/deployment-run.ts', 'src/services/state.ts', 'src/services/container.ts', 'src/services/isolated-shell-executor.ts', 'src/services/observation-supervisor-process.ts', 'src/services/observation-executor-process.ts', 'src/services/observation-process-launcher.ts', 'src/services/observation-process.ts', 'src/services/observation-process-group.ts',
  'src/services/shell-executor.ts', 'src/executor/routes.ts', 'src/services/worktree.ts', 'src/services/deployment-version.ts', 'src/services/env-provenance.ts', 'scripts/artifact-admission-drill.ts'];

async function acceptWorker(): Promise<void> {
  assert.ok(process.connected && process.send);
  const stateFile = value('--state');
  assert.ok(stateFile.startsWith(path.join(os.tmpdir(), 'cds-artifact-ci-')));
  const payload = JSON.parse(value('--input')) as { branch: BranchEntry; profiles: BuildProfile[]; admission: ArtifactAdmission };
  assert.equal(payload.admission.state, 'waiting'); assert.equal(payload.admission.reason, 'missing');
  const m = await modules(); const state = new m.state.StateService(stateFile); state.load();
  state.addProject({ id: 'owned', name: '隔离产物演练', slug: 'owned' } as any); state.addBranch(payload.branch);
  const coordinator = new m.coordinator.BranchOperationCoordinator();
  const runs = new m.runs.DeploymentRunService(state); runs.bindOperationCoordinator(coordinator);
  const request = { projectId: 'owned', branchId: payload.branch.id, kind: 'deploy' as const, trigger: 'webhook' as const,
    actor: 'owned-original', source: 'isolated.registry', commitSha: payload.admission.targetCommitSha, commitPinned: true, configHash: 'owned-original-config' };
  const decision = coordinator.begin(request, { waitForArtifacts: true }); assert.equal(decision.status, 'merged');
  const input = m.input.captureDeploymentInput(payload.branch, payload.profiles, { TOKEN: 'synthetic-private-input' }, undefined, request.commitSha);
  input.configHash = request.configHash; input.artifactAdmission = payload.admission;
  coordinator.rememberDeploymentInput(decision.operationId, decision.generation, input);
  const run = await runs.begin({ projectId: 'owned', branchId: payload.branch.id, trigger: 'webhook', initialStatus: 'queued',
    operationId: decision.operationId, operationGeneration: decision.generation, commitSha: request.commitSha,
    configHash: request.configHash, phase: 'artifact-wait', executionInput: { request, input } });
  assert.deepEqual(coordinator.drainReady(), []); assert.equal(coordinator.getActiveOperations(payload.branch.id).length, 0);
  process.send!({ runId: run.id, operationId: run.operationId, generation: run.operationGeneration, phase: 'accepted' });
  setInterval(() => {}, 1000);
}

async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux');
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  if (process.argv.includes('--worker')) { await acceptWorker(); return; }
  const host = 'unix:///var/run/docker.sock';
  const docker = (args: string[]): string => execFileSync('docker', ['--host', host, ...args], { encoding: 'utf8', timeout: 120_000 }).trim();
  const owner = `cds_artifact_${randomBytes(8).toString('hex')}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-artifact-ci-')); await fs.chmod(temp, 0o700);
  const output = path.resolve('artifact-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); assert.match(head, /^[0-9a-f]{40}$/);
  const report: Record<string, any> = { schema: 1, head, startedAt: new Date().toISOString(), verdict: 'failed', checks: [],
    scope: 'compiled artifact checker, durable queue, original Master remote dispatch and executor HTTP routes, second empty Docker daemon and managed producer/version content policy; owned registry, Git and Docker; no full application/public cutover, full configuration rollback or performance acceptance',
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]))),
    actualRegistryPublishResumeVerified: false, actualExecutorArtifactDeploymentVerified: false, actualManagedProducerPolicyVerified: false, actualLocalVersionContentRestoreVerified: false, actualExecutorRepositoryDigestReuseVerified: false, actualSecondDaemonDigestRecoveryVerified: false, actualMasterRemoteRepositoryDigestVerified: false, actualApplicationDeploymentVerified: false, performanceVerified: false,
    ownedContainersRemoved: false, ownedImagesRemoved: false, isolatedFilesRemoved: false };
  const m = await modules();
  const previousHost = process.env.DOCKER_HOST, previousContext = process.env.DOCKER_CONTEXT, previousIsolation = process.env.CDS_BRANCH_NETWORK_ISOLATION;
  let peerServer: http.Server | undefined, masterServer: http.Server | undefined, peerNetwork: string | undefined;
  let flushMaster: (() => Promise<void>) | undefined;
  let secondaryDaemon: string | undefined, secondaryVolume: string | undefined, secondaryRuntime: string | undefined;
  const ownedVolumes: string[] = [];
  const secondary = (args: string[]) => { assert.ok(secondaryDaemon); ownedView(secondaryDaemon); return docker(['exec', secondaryDaemon, 'docker', '--host', 'unix:///var/run/owned.sock', ...args]); };
  process.env.DOCKER_HOST = host; delete process.env.DOCKER_CONTEXT;
  const shell = new m.isolated.IsolatedShellExecutor(new m.shell.ShellExecutor(), { isolatedLane: 'operation', concurrency: 2,
    reservedCleanup: 1, maxQueued: 8, maxBytes: 1024 * 1024, reservedCleanupBytes: 64 * 1024 });
  const container = new m.container.ContainerService(shell, { repoRoot: temp, worktreeBase: temp, dockerNetwork: 'bridge',
    sharedEnv: {}, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'owned' } } as CdsConfig);
  const ownedIds: string[] = [], imageIds = new Set<string>();
  const fixtureImage = 'node:22-alpine';
  const ownedView = (id: string): any => {
    assert.match(id, /^[a-f0-9]{64}$/); const view = JSON.parse(docker(['inspect', id]))[0];
    assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); return view;
  };
  const start = (name: string, args: string[]): string => {
    const id = docker(['run', '-d', '--name', `${owner}-${name}`, '--label', `cds.acceptance.owner=${owner}`, ...args]);
    ownedIds.push(id); ownedView(id); return id;
  };
  const read = async (url: string): Promise<string> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200); return response.text();
  };
  const waitHttp = async (url: string): Promise<void> => {
    const until = performance.now() + 30_000;
    for (;;) { try { await read(url); return; } catch (error) { if (performance.now() > until) throw error; await new Promise(resolve => setTimeout(resolve, 250)); } }
  };
  const publishedPort = async (id: string, containerPort: string): Promise<string> => {
    const until = performance.now() + 5000;
    for (;;) {
      const view = ownedView(id);
      if (!view.State.Running) {
        report.fixtureFailure = { image: view.Config.Image, status: view.State.Status, exitCode: view.State.ExitCode,
          error: view.State.Error, logs: docker(['logs', '--tail', '20', id]).slice(-4096) };
        throw new Error('Owned HTTP fixture exited before ready');
      }
      const binding = view.NetworkSettings.Ports?.[containerPort]?.[0];
      if (binding) { assert.equal(binding.HostIp, '127.0.0.1'); return binding.HostPort; }
      if (performance.now() > until) throw new Error('Owned HTTP fixture port was not published within 5 seconds');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const build = async (role: string, ref: string): Promise<void> => {
    const context = path.join(temp, role); await fs.mkdir(context); await fs.writeFile(path.join(context, 'index.html'), `${role}:${head}`);
    await fs.writeFile(path.join(context, 'server.cjs'), "const http=require('node:http'),fs=require('node:fs');http.createServer((_req,res)=>{res.setHeader('Content-Type','text/plain');res.end(fs.readFileSync('/www/index.html','utf8'));}).listen(Number(process.env.PORT||8080),'0.0.0.0');");
    await fs.writeFile(path.join(context, 'Dockerfile'), `FROM ${fixtureImage}\nLABEL cds.acceptance.owner="${owner}" org.opencontainers.image.revision="${head}"\nCOPY index.html /www/index.html\nCOPY server.cjs /server.cjs\nCMD ["node", "/server.cjs"]\n`);
    docker(['build', '--network', 'none', '-t', ref, context]);
    const image = JSON.parse(docker(['image', 'inspect', ref]))[0]; assert.equal(image.Config.Labels['cds.acceptance.owner'], owner);
    imageIds.add(image.Id); docker(['push', ref]);
  };
  try {
    await shell.start(); report.stage = 'registry-ready'; docker(['pull', 'registry:2']); docker(['pull', fixtureImage]);
    const registryReservation = http.createServer(); await new Promise<void>(resolve => registryReservation.listen(0, '127.0.0.1', resolve));
    const port = (registryReservation.address() as { port: number }).port; await new Promise<void>(resolve => registryReservation.close(() => resolve()));
    const registryVolume = `${owner}-registry-data`;
    docker(['volume', 'create', '--label', `cds.acceptance.owner=${owner}`, registryVolume]); ownedVolumes.push(registryVolume);
    const registryId = start('registry', ['--cpus', '0.5', '--memory', '128m', '--network', 'host',
      '-e', `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`, '-v', `${registryVolume}:/var/lib/registry`, 'registry:2']);
    const registry = `127.0.0.1:${port}`; await waitHttp(`http://${registry}/v2/`);
    report.registryEndpoint = { directHostLoopback: true, port, containerId: registryId, dataVolume: registryVolume };
    report.stage = 'old-http-fixture-ready';
    const oldId = start('old', ['--cpus', '0.25', '--memory', '128m', '-p', '127.0.0.1::8080', fixtureImage, 'node', '-e',
      "require('node:http').createServer((_req,res)=>res.end('old-ready')).listen(8080,'0.0.0.0')"]);
    const oldPort = await publishedPort(oldId, '8080/tcp');
    const oldUrl = `http://127.0.0.1:${oldPort}/`; await waitHttp(oldUrl); assert.equal((await read(oldUrl)).trim(), 'old-ready');
    const apiRef = `${registry}/owned-api:sha-${head}`, webRef = `${registry}/owned-web:sha-${head}`;
    await build('api', apiRef);
    const profiles: BuildProfile[] = ['api', 'worker', 'web'].map(id => ({ id, projectId: 'owned', name: id,
      dockerImage: id === 'web' ? webRef : apiRef, prebuiltImage: true, workDir: '.', command: '', containerPort: 8080 }));
    const branch: BranchEntry = { id: 'owned-branch', projectId: 'owned', branch: 'owned', status: 'running', worktreePath: temp,
      createdAt: new Date().toISOString(), githubCommitSha: 'a'.repeat(40), services: { api: { profileId: 'api', containerName: oldId, hostPort: Number(oldPort), status: 'running' } } };
    report.stage = 'last-required-missing';
    const admission = await container.inspectDeploymentArtifacts(profiles, head, () => ownedView(oldId));
    assert.equal(admission.state, 'waiting'); assert.equal(admission.reason, 'missing'); assert.deepEqual(admission.profileIds, ['web']);
    assert.deepEqual(admission.artifacts, []); assert.equal((await read(oldUrl)).trim(), 'old-ready');
    report.checks.push({ name: 'real-last-required-missing-old-http-retained', passed: true });
    const stateFile = path.join(temp, 'state.json');
    const child = fork(fileURLToPath(import.meta.url), ['--worker', '--state', stateFile, '--input', JSON.stringify({ branch, profiles, admission })],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, CDS_SECRET_KEY: '27'.repeat(32) } });
    let accepted: any;
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      accepted = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned acceptance worker timed out')), 20_000);
        child.once('message', message => { clearTimeout(timer); resolve(message); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Owned worker exited ${code}/${signal}`)); });
      });
      assert.equal(accepted.phase, 'accepted');
    } finally { child.kill('SIGKILL'); report.workerExit = await exited; }
    assert.equal(report.workerExit.signal, 'SIGKILL');
    process.env.CDS_SECRET_KEY = '27'.repeat(32);
    const state = new m.state.StateService(stateFile); state.load();
    const runs = new m.runs.DeploymentRunService(state); const coordinator = new m.coordinator.BranchOperationCoordinator();
    assert.deepEqual(runs.restoreQueued(coordinator).map(run => run.id), [accepted.runId]);
    const [{ pending, input }] = coordinator.getArtifactWaiters();
    assert.equal(pending.operationId, accepted.operationId); assert.equal(pending.generation, accepted.generation);
    assert.equal(pending.request.actor, 'owned-original'); assert.equal(pending.request.source, 'isolated.registry');
    assert.equal(input.configuredEnv.TOKEN, 'synthetic-private-input'); assert.equal(input.configHash, 'owned-original-config');
    assert.equal(coordinator.getActiveOperations(branch.id).length, 0); assert.deepEqual(coordinator.drainReady(), []);
    assert.deepEqual(await m.wait.refreshArtifactWaiters({ coordinator, containerService: container, getBranch: id => state.getBranch(id), recheckMs: 0 }), []);
    assert.equal(runs.get(accepted.runId)?.status, 'queued'); assert.equal((await read(oldUrl)).trim(), 'old-ready');
    report.checks.push({ name: 'sigkill-after-confirmed-wait-restores-original-identity-and-private-input', passed: true });
    // 原编译执行器HTTP入口，接实际Docker；仓库目录故意无Git，证明预构建不依赖源码。
    report.stage = 'executor-http-missing-all-required';
    const peerState = new m.state.StateService(path.join(temp, 'peer-state.json')); peerState.load();
    peerState.addProject({ id: 'owned', slug: 'owned', name: '隔离执行器' } as any);
    const protectedId = `${owner}-protected`;
    const protectedEntry: BranchEntry = { id: protectedId, projectId: 'owned', branch: 'owned-artifact', worktreePath: path.join(temp, 'no-git'),
      status: 'running', createdAt: new Date().toISOString(), services: { legacy: { profileId: 'legacy', containerName: ownedView(oldId).Name.slice(1),
        hostPort: Number(oldPort), status: 'running' } } };
    peerState.addBranch(protectedEntry);
    const peerCommands: string[] = [];
    const peerShell = new Proxy(shell, { get(target, property) {
      if (property === 'exec') return (command: string, options: any) => { peerCommands.push(command); return target.exec(command, options); };
      const item = Reflect.get(target, property); return typeof item === 'function' ? item.bind(target) : item;
    } });
    const reserve = http.createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const peerPortStart = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
    peerNetwork = `${owner}-network`; docker(['network', 'create', '--label', `cds.acceptance.owner=${owner}`, peerNetwork]);
    process.env.CDS_BRANCH_NETWORK_ISOLATION = '0'; // 仅本隔离进程使用自有user-defined网络，非生产隔离验收。
    const peerConfig = { repoRoot: temp, worktreeBase: path.join(temp, 'peer-worktrees'), dockerNetwork: peerNetwork,
      portStart: peerPortStart, sharedEnv: {}, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'owned' }, executorToken: randomBytes(32).toString('hex') } as CdsConfig;
    const peerContainer = new m.container.ContainerService(peerShell, peerConfig);
    const peerRequests: any[] = [];
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { if (req.method === 'POST' && req.path === '/exec/deploy') peerRequests.push(structuredClone(req.body)); next(); }); app.use('/exec', m.executor.createExecutorRouter({ stateService: peerState,
      worktreeService: new m.worktree.WorktreeService(peerShell), containerService: peerContainer, shell: peerShell, config: peerConfig }));
    peerServer = await new Promise<http.Server>(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const peerUrl = `http://127.0.0.1:${(peerServer.address() as { port: number }).port}`;
    const peerPost = async (body: unknown) => {
      const response = await fetch(`${peerUrl}/exec/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Executor-Token': peerConfig.executorToken! },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }); assert.equal(response.status, 200);
      const text = await response.text();
      return text.split('\n\n').filter(Boolean).map(block => ({ event: block.match(/^event: (.+)$/m)?.[1], data: JSON.parse(block.match(/^data: (.+)$/m)![1]) }));
    };
    const beforeProtected = structuredClone(protectedEntry), beforeCommands = peerCommands.length;
    const refused = await peerPost({ branchId: protectedId, branchName: protectedEntry.branch, projectId: 'owned', commitSha: head, profiles });
    assert.equal(refused.find(event => event.event === 'error')?.data.accepted, false);
    assert.equal(refused.find(event => event.event === 'error')?.data.reason, 'missing');
    assert.deepEqual(peerState.getBranch(protectedId), beforeProtected); assert.equal((await read(oldUrl)).trim(), 'old-ready');
    assert.equal(peerCommands.slice(beforeCommands).some(command => /^git |^mkdir |^docker (run|create|stop|rm)/.test(command)), false);
    report.checks.push({ name: 'compiled-executor-http-rejects-missing-last-role-before-mutation', passed: true });

    report.stage = 'publish-final-required'; await build('web', webRef);
    const ready = await m.wait.refreshArtifactWaiters({ coordinator, containerService: container, getBranch: id => state.getBranch(id), recheckMs: 0 });
    assert.equal(ready.length, 1); assert.equal(ready[0].operationId, accepted.operationId); assert.equal(ready[0].generation, accepted.generation);
    const replay = { ...ready[0].request, pendingReplay: m.coordinator.pendingDeployBody(ready[0]).pendingReplay as typeof pending.request.pendingReplay };
    const admitted = coordinator.getDeploymentInputForReplay(replay)!;
    assert.equal(admitted.artifactAdmission?.state, 'ready'); assert.equal(admitted.artifactAdmission.artifacts.length, 2);
    assert.equal(admitted.artifactAdmission.artifacts.find(item => item.requestedImage === apiRef)?.profileIds.length, 2);
    const claim = coordinator.begin(replay); assert.equal(claim.status, 'started'); await runs.claimQueued(accepted.runId);
    assert.deepEqual(await m.wait.refreshArtifactWaiters({ coordinator, containerService: container, getBranch: id => state.getBranch(id), recheckMs: 0 }), []);
    assert.equal(runs.list().length, 1); assert.equal((await read(oldUrl)).trim(), 'old-ready');
    const fixed = m.artifacts.admittedArtifactProfile(profiles[2], admitted.artifactAdmission);
    assert.match(fixed.dockerImage!, /@sha256:[0-9a-f]{64}$/); assert.equal(fixed.localArtifact, true); assert.equal(fixed.sourceFallbackProfile, undefined);
    const newId = start('new', ['--cpus', '0.25', '--memory', '128m', '-p', '127.0.0.1::8080', fixed.dockerImage!]);
    const newPort = await publishedPort(newId, '8080/tcp');
    await waitHttp(`http://127.0.0.1:${newPort}/`); assert.equal(await read(`http://127.0.0.1:${newPort}/`), `web:${head}`);
    assert.equal(ownedView(newId).Config.Labels['org.opencontainers.image.revision'], head);
    const cold = new m.state.StateService(stateFile); cold.load();
    assert.deepEqual(new m.runs.DeploymentRunService(cold).restoreQueued(new m.coordinator.BranchOperationCoordinator()), []);
    report.originalTask = { runId: accepted.runId, operationId: pending.operationId, generation: pending.generation,
      restoredAfterSigkill: true, runCount: runs.list().length, claimedStatus: runs.get(accepted.runId)?.status };
    report.artifacts = admitted.artifactAdmission.artifacts; report.oldHttpRetained = true; report.newFixture = { image: fixed.dockerImage, revision: head, httpReady: true };
    report.actualRegistryPublishResumeVerified = true;
    report.checks.push({ name: 'real-all-required-publish-claims-original-once-and-runs-fixed-digest-fixture', passed: true });
    report.stage = 'executor-http-runs-verified-artifact-without-git';
    const peerBranchId = `${owner}-ready`;
    const peerProfile = { ...profiles[2], resources: { cpus: 0.25, memoryMB: 128 }, readinessProbe: { path: '/', intervalSeconds: 1, timeoutSeconds: 20 } };
    const beforePeer = peerCommands.length;
    const peerEvents = await peerPost({ branchId: peerBranchId, branchName: 'owned-artifact-only', projectId: 'owned', artifactCommitSha: head, profiles: [peerProfile] });
    assert.deepEqual(peerEvents.filter(event => event.event === 'error' || event.data?.status === 'error'), []);
    assert.ok(peerEvents.some(event => event.event === 'complete'));
    const peerEntry = peerState.getBranch(peerBranchId)!; assert.equal(peerEntry.status, 'running');
    const peerService = peerEntry.services.web; assert.match(peerService.deployedImage!, /@sha256:[0-9a-f]{64}$/);
    const peerId = docker(['inspect', '--format', '{{.Id}}', peerService.containerName]); ownedView(peerId); ownedIds.push(peerId);
    const peerRuntime = ownedView(peerId); assert.equal(peerRuntime.Config.Labels['org.opencontainers.image.revision'], head);
    // 当前应用运行时明确不把resources调度提示下发为cgroup限制；本组件不签容量/硬限额验收。
    assert.equal(peerRuntime.HostConfig.NanoCpus, 0);
    report.executorResourceScope = { schedulingHintsOnly: true, runtimeNanoCpus: peerRuntime.HostConfig.NanoCpus,
      hardResourceLimitsVerified: false };
    await waitHttp(`http://127.0.0.1:${peerService.hostPort}/`); assert.equal(await read(`http://127.0.0.1:${peerService.hostPort}/`), `web:${head}`);
    assert.equal(peerCommands.slice(beforePeer).some(command => /^git |^mkdir /.test(command)), false);
    assert.equal((await read(oldUrl)).trim(), 'old-ready');
    report.actualExecutorArtifactDeploymentVerified = true;
    report.executorArtifact = { revision: head, image: peerService.deployedImage, httpReady: true, noSourcePreparation: true,
      missingAllRolesPreservedOldHttp: true, scope: 'actual compiled executor HTTP route through original process pool and Docker; owned user-defined network; no Master/public cutover or managed-source policy acceptance' };
    report.checks.push({ name: 'compiled-executor-http-runs-fixed-digest-real-version-without-source', passed: true });

    report.stage = 'executor-retains-verified-local-repository-digest';
    const repositoryDigest = peerService.deployedImage!;
    const localPeerProfile = { ...peerProfile, dockerImage: repositoryDigest, localArtifact: true };
    const beforeLocalPeer = peerCommands.length;
    const masterState = new m.state.StateService(path.join(temp, 'master-state.json')); masterState.load();
    masterState.addProject({ id: 'owned', slug: 'owned', name: '隔离派发', kind: 'git', legacyFlag: true, dockerNetwork: peerNetwork, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    masterState.addBuildProfile({ ...localPeerProfile, localArtifact: false });
    masterState.addBranch({ ...structuredClone(peerEntry), githubCommitSha: head });
    const masterRegistry = new m.registry.ExecutorRegistry(masterState);
    const remote = masterRegistry.register({ id: `${owner}-executor`, host: '127.0.0.1', port: (peerServer.address() as { port: number }).port,
      role: 'remote', capacity: { maxBranches: 10, memoryMB: 2048, cpuCores: 2 } });
    const masterCoordinator = new m.coordinator.BranchOperationCoordinator(); const masterRuns = new m.runs.DeploymentRunService(masterState);
    const masterVersions = new m.versions.DeploymentVersionService(masterState);
    const masterConfig = { ...peerConfig, mode: 'standalone', masterPort: 0, workerPort: 5500, executorPort: 5501,
      rootDomains: ['invalid'], previewDomain: 'invalid' } as CdsConfig;
    const masterApp = express(); masterApp.use(express.json()); masterApp.use('/api', m.branches.createBranchRouter({ stateService: masterState,
      worktreeService: new m.worktree.WorktreeService(peerShell), containerService: peerContainer, shell: peerShell, config: masterConfig,
      registry: masterRegistry, branchOperationCoordinator: masterCoordinator, deploymentRunService: masterRuns, deploymentVersionService: masterVersions }));
    masterServer = await new Promise<http.Server>(resolve => { const server = masterApp.listen(0, '127.0.0.1', () => resolve(server)); });
    masterConfig.masterPort = (masterServer.address() as { port: number }).port;
    flushMaster = async () => { masterCoordinator.interruptAll('owned cleanup', 'isolated-drill'); await masterState.flush(); };
    const beforeMasterRequests = peerRequests.length;
    const masterResponse = await fetch(`http://127.0.0.1:${masterConfig.masterPort}/api/branches/${peerBranchId}/deploy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitSha: head, targetExecutorId: remote.id }), signal: AbortSignal.timeout(90_000) });
    assert.equal(masterResponse.status, 200); const masterText = await masterResponse.text();
    const localPeerEvents = masterText.split('\n\n').filter(Boolean).filter(block => /^data: /m.test(block)).map(block => ({ event: block.match(/^event: (.+)$/m)?.[1], data: JSON.parse(block.match(/^data: (.+)$/m)![1]) }));
    const dispatched = peerRequests.slice(beforeMasterRequests); assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].profiles[0].dockerImage, repositoryDigest); assert.equal(dispatched[0].artifactCommitSha, head);
    const masterEntry = masterState.getBranch(peerBranchId)!; assert.equal(masterEntry.status, 'running');
    assert.equal(masterEntry.services.web.deployedImage, repositoryDigest); assert.ok(masterEntry.currentVersionId);
    const masterVersion = masterVersions.get(masterEntry.currentVersionId!)!;
    assert.equal(masterVersion.profiles[0].artifactImage, repositoryDigest); assert.equal(masterVersion.profiles[0].artifactKind, 'prebuilt-image');
    assert.equal(masterVersions.materializeProfiles(masterVersion, [localPeerProfile])[0].localArtifact, false);
    report.masterRepositoryDigest = { dispatchedImage: dispatched[0].profiles[0].dockerImage, versionId: masterVersion.id,
      originalMasterRoute: true, originalExecutorHttp: true, versionRepositoryReferencePreserved: true };
    report.actualMasterRemoteRepositoryDigestVerified = true;

    assert.deepEqual(localPeerEvents.filter(event => event.event === 'error' || event.data?.status === 'error'), []);
    assert.ok(localPeerEvents.some(event => event.event === 'complete'));
    const localPeerEntry = peerState.getBranch(peerBranchId)!; const localPeerService = localPeerEntry.services.web;
    assert.equal(localPeerService.deployedImage, repositoryDigest);
    const localPeerId = docker(['inspect', '--format', '{{.Id}}', localPeerService.containerName]);
    const localPeerRuntime = ownedView(localPeerId); assert.notEqual(localPeerId, peerId);
    assert.equal(localPeerRuntime.Config.Image, repositoryDigest);
    assert.equal(localPeerRuntime.Config.Labels['org.opencontainers.image.revision'], head);
    assert.equal(docker(['ps', '-aq', '--no-trunc', '--filter', `id=${peerId}`]), '');
    ownedIds.splice(ownedIds.indexOf(peerId), 1); ownedIds.push(localPeerId);
    await waitHttp(`http://127.0.0.1:${localPeerService.hostPort}/`); assert.equal(await read(`http://127.0.0.1:${localPeerService.hostPort}/`), `web:${head}`);
    assert.equal(peerCommands.slice(beforeLocalPeer).some(command => /^git |^mkdir /.test(command)), false);
    const fixedPulls = peerCommands.slice(beforeLocalPeer).filter(command => /^docker pull /.test(command));
    assert.equal(fixedPulls.length, 1); assert.ok(fixedPulls[0].includes(repositoryDigest));
    const localPeerVersions = new m.versions.DeploymentVersionService(peerState);
    const portableVersion = localPeerVersions.create({ projectId: 'owned', branchId: peerBranchId, commitSha: head,
      configHash: localPeerVersions.computeConfigHash([localPeerProfile], {}), profiles: [localPeerProfile], branch: localPeerEntry, createdByRunId: 'owned-executor-portable-reference' });
    assert.equal(portableVersion.profiles[0].artifactKind, 'prebuilt-image'); assert.equal(portableVersion.profiles[0].artifactImage, repositoryDigest);
    assert.equal(localPeerVersions.materializeProfiles(portableVersion, [localPeerProfile])[0].dockerImage, repositoryDigest);
    report.executorRepositoryDigest = { repositoryDigest, localContentId: localPeerRuntime.Image, portableVersionId: portableVersion.id,
      runtimeReferencePreserved: true, versionReferencePreserved: true, masterFixedUriPreflightPulls: fixedPulls.length, executorLocalRecheckWithoutAdditionalPull: true, noSourcePreparation: true };
    report.actualExecutorRepositoryDigestReuseVerified = true;
    report.checks.push({ name: 'compiled-master-remote-preflight-and-executor-preserve-fixed-repository-digest-and-version-reference', passed: true });

    // 第二个自有daemon无主daemon socket或缓存挂载，只从版本记录保留的仓库URI拉取。
    // 仅CI临时runner内的特权容器；禁用bridge、iptables与转发修改，数据卷有独立归属。
    report.stage = 'second-daemon-fixed-repository-recovery';
    docker(['pull', 'docker:29-dind']);
    const daemonImage = JSON.parse(docker(['image', 'inspect', 'docker:29-dind']))[0];
    secondaryVolume = `${owner}-secondary-data`;
    docker(['volume', 'create', '--label', `cds.acceptance.owner=${owner}`, secondaryVolume]); ownedVolumes.push(secondaryVolume);
    assert.equal(JSON.parse(docker(['volume', 'inspect', secondaryVolume]))[0].Labels['cds.acceptance.owner'], owner);
    secondaryDaemon = start('secondary-daemon', ['--privileged', '--network', 'host', '--cpus', '1', '--memory', '1g',
      '-v', `${secondaryVolume}:/var/lib/docker`, '-e', 'DOCKER_TLS_CERTDIR=', 'docker:29-dind',
      'dockerd', '--host=unix:///var/run/owned.sock', '--storage-driver=vfs', '--feature=containerd-snapshotter=false',
      '--bridge=none', '--iptables=false', '--ip6tables=false', '--ip-forward=false', '--ip-masq=false']);
    const daemonMounts = ownedView(secondaryDaemon).Mounts;
    assert.equal(daemonMounts.length, 1); assert.equal(daemonMounts[0].Type, 'volume'); assert.equal(daemonMounts[0].Name, secondaryVolume);
    assert.equal(daemonMounts[0].Destination, '/var/lib/docker');
    const daemonDeadline = performance.now() + 30_000;
    for (;;) { try { secondary(['info', '--format', '{{.ID}}']); break; } catch (error) {
      if (!ownedView(secondaryDaemon).State.Running || performance.now() > daemonDeadline) {
        report.secondaryDaemonFailure = { logs: docker(['logs', '--tail', '30', secondaryDaemon]).slice(-4096) }; throw error;
      } await new Promise(resolve => setTimeout(resolve, 250));
    } }
    const secondaryInfo = JSON.parse(secondary(['info', '--format', '{{json .}}']));
    const primaryInfo = JSON.parse(docker(['info', '--format', '{{json .}}']));
    assert.notEqual(secondaryInfo.ID, primaryInfo.ID); assert.equal(secondaryInfo.Driver, 'vfs');
    assert.equal(secondary(['image', 'ls', '-aq']), ''); assert.equal(secondary(['ps', '-aq']), '');
    report.secondDaemonEndpoint = { runnerNamespace: await fs.readlink('/proc/self/ns/net'),
      daemonNamespace: docker(['exec', secondaryDaemon, 'readlink', '/proc/self/ns/net']), primaryEndpointHttpReady: false, secondaryEndpointHttpReady: false };
    await waitHttp(`http://${registry}/v2/`); report.secondDaemonEndpoint.primaryEndpointHttpReady = true;
    assert.equal(docker(['exec', secondaryDaemon, 'wget', '-qO-', '-T', '5', `http://${registry}/v2/`]), '{}');
    report.secondDaemonEndpoint.secondaryEndpointHttpReady = true;

    const recoveredProfile = masterVersions.materializeProfiles(masterVersion, [localPeerProfile])[0];
    assert.equal(recoveredProfile.localArtifact, false);
    assert.equal(recoveredProfile.dockerImage, repositoryDigest);
    secondary(['pull', recoveredProfile.dockerImage!]);
    const recoveredImage = JSON.parse(secondary(['image', 'inspect', repositoryDigest]))[0];
    assert.equal(recoveredImage.Id, localPeerRuntime.Image); assert.ok(recoveredImage.RepoDigests.includes(repositoryDigest));
    assert.equal(recoveredImage.Config.Labels['cds.acceptance.owner'], owner);
    assert.equal(recoveredImage.Config.Labels['org.opencontainers.image.revision'], head);
    assert.equal(recoveredImage.Os, 'linux'); assert.equal(recoveredImage.Architecture, JSON.parse(docker(['image', 'inspect', repositoryDigest]))[0].Architecture);
    assert.equal(recoveredImage.Architecture, secondaryInfo.Architecture === 'x86_64' ? 'amd64' : secondaryInfo.Architecture);
    assert.deepEqual(recoveredImage.Config.Cmd, ['node', '/server.cjs']);
    const secondPortReservation = http.createServer(); await new Promise<void>(resolve => secondPortReservation.listen(0, '127.0.0.1', resolve));
    const secondPort = (secondPortReservation.address() as { port: number }).port; await new Promise<void>(resolve => secondPortReservation.close(() => resolve()));
    secondaryRuntime = secondary(['run', '-d', '--name', `${owner}-recovered`, '--label', `cds.acceptance.owner=${owner}`,
      '--network', 'host', '--cpus', '0.25', '--memory', '128m', '-e', `PORT=${secondPort}`, repositoryDigest]);
    const recoveredRuntime = JSON.parse(secondary(['inspect', secondaryRuntime]))[0];
    assert.equal(recoveredRuntime.Config.Labels['cds.acceptance.owner'], owner); assert.equal(recoveredRuntime.Config.Image, repositoryDigest);
    assert.equal(recoveredRuntime.Image, recoveredImage.Id); assert.deepEqual(recoveredRuntime.Config.Cmd, recoveredImage.Config.Cmd);
    await waitHttp(`http://127.0.0.1:${secondPort}/`); assert.equal(await read(`http://127.0.0.1:${secondPort}/`), `web:${head}`);
    report.secondDaemonRecovery = { primaryDaemonId: primaryInfo.ID, secondaryDaemonId: secondaryInfo.ID,
      daemonImage: daemonImage.RepoDigests, initiallyEmpty: true, volume: secondaryVolume, repositoryDigest,
      imageId: recoveredImage.Id, revision: head, platform: `${recoveredImage.Os}/${recoveredImage.Architecture}`,
      defaultCommandPreserved: true, actualHttpContentVerified: true, noPrimaryCacheOrSocketMounted: true };
    report.actualSecondDaemonDigestRecoveryVerified = true;
    report.checks.push({ name: 'second-owned-empty-daemon-pulls-version-repository-digest-and-runs-original-image-content', passed: true });

    report.stage = 'managed-source-and-environment-identity';
    const sourceDir = path.join(temp, 'managed-source'); await fs.mkdir(sourceDir);
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', sourceDir, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
    git(['init', '--quiet']);
    await fs.writeFile(path.join(sourceDir, 'version.txt'), 'source-one');
    await fs.writeFile(path.join(sourceDir, 'server.cjs'), "const http=require('node:http'),fs=require('node:fs');http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source:fs.readFileSync('/app/version.txt','utf8').trim(),built:fs.readFileSync('/app/build-sha.txt','utf8').trim(),runtime:process.env.CDS_COMMIT_SHA,flavor:process.env.OWNED_FLAVOR}));}).listen(8080,'0.0.0.0');");
    const commit = (subject: string) => { git(['add', '.']); git(['-c', 'user.name=CDS隔离验收', '-c', 'user.email=owned@example.invalid', 'commit', '--quiet', '-m', subject]); return git(['rev-parse', 'HEAD']); };
    const sourceOne = commit('隔离源码第一版'); assert.match(sourceOne, /^[0-9a-f]{40}$/);
    const managedPortListener = http.createServer(); await new Promise<void>(resolve => managedPortListener.listen(0, '127.0.0.1', resolve));
    const managedPort = (managedPortListener.address() as { port: number }).port; await new Promise<void>(resolve => managedPortListener.close(() => resolve()));
    const managedEntry: BranchEntry = { id: `${owner}-managed`, projectId: 'owned', branch: 'owned-managed', status: 'idle', worktreePath: sourceDir,
      createdAt: new Date().toISOString(), githubCommitSha: 'a'.repeat(40), pinnedCommit: 'e'.repeat(40), ciTargetSha: head,
      services: { managed: { profileId: 'managed', containerName: `${owner}-managed`, hostPort: managedPort, status: 'idle' } } };
    peerState.addBranch(managedEntry); const managedRuntime = managedEntry.services.managed;
    const artifactTag = `owned-${owner}:managed`;
    const managedProfile: BuildProfile = { id: 'managed', projectId: 'owned', name: '隔离受管程序', dockerImage: apiRef, workDir: '.', containerWorkDir: '/app',
      command: 'unused-source-command', containerPort: 8080, env: { OWNED_FLAVOR: 'first' }, managedBuild: { stack: 'node', artifactImage: artifactTag,
        installCommand: 'true', buildCommand: `node -e 'require("node:fs").writeFileSync("/app/build-sha.txt",process.env.CDS_COMMIT_SHA)'`, startCommand: 'node /app/server.cjs' } };
    const managedUrl = `http://127.0.0.1:${managedPort}/`;
    const managedBody = async () => { await waitHttp(managedUrl); return JSON.parse(await read(managedUrl)); };
    const ownImage = (image: string) => { const view = JSON.parse(docker(['image', 'inspect', image]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); imageIds.add(view.Id); return view; };
    const verifiedManagedImage = (image: string, source: string) => { const view = ownImage(image); assert.equal(view.Os, 'linux');
      const platform = JSON.parse(docker(['info', '--format', '{{json .}}'])); assert.equal(view.Architecture, platform.Architecture === 'x86_64' ? 'amd64' : platform.Architecture);
      assert.equal(view.Config.Labels['org.opencontainers.image.revision'], source); assert.match(view.Config.Labels['cds.managed.contract'], /^[a-f0-9]{64}$/); return view; };
    const firstCommands = peerCommands.length;
    await peerContainer.runService(managedEntry, managedProfile, managedRuntime);
    const imageOne = managedRuntime.deployedImage!; assert.match(imageOne, /^sha256:[a-f0-9]{64}$/);
    verifiedManagedImage(imageOne, sourceOne); assert.deepEqual(await managedBody(), { source: 'source-one', built: sourceOne, runtime: sourceOne, flavor: 'first' });
    assert.equal(peerCommands.slice(firstCommands).filter(command => command.startsWith('docker exec') && command.includes('-managed-build-')).length, 1);
    const versions = new m.versions.DeploymentVersionService(peerState);
    const versionOne = versions.create({ projectId: 'owned', branchId: managedEntry.id, commitSha: sourceOne, configHash: ownImage(imageOne).Config.Labels['cds.managed.contract'],
      profiles: [managedProfile], branch: managedEntry, createdByRunId: 'owned-managed-one' });
    assert.equal(versionOne.profiles[0].artifactImage, imageOne); assert.equal(versionOne.profiles[0].reusable, true);
    report.checks.push({ name: 'compiled-managed-producer-source-build-runtime-and-oci-identities-match', passed: true });

    report.stage = 'managed-cache-reuse'; const beforeReuse = peerCommands.length;
    managedEntry.lastDeployDispatchAt = new Date().toISOString();
    await peerContainer.runService(managedEntry, managedProfile, managedRuntime);
    assert.equal(managedRuntime.deployedImage, imageOne); assert.equal(peerCommands.slice(beforeReuse).some(command => /^docker (cp|exec|commit)/.test(command) || command.includes('-managed-build-')), false);
    assert.deepEqual(await managedBody(), { source: 'source-one', built: sourceOne, runtime: sourceOne, flavor: 'first' });
    report.checks.push({ name: 'compiled-managed-same-source-platform-and-contract-reuses-fixed-content', passed: true });

    report.stage = 'managed-source-change'; await fs.writeFile(path.join(sourceDir, 'version.txt'), 'source-two');
    const sourceTwo = commit('隔离源码第二版'); assert.notEqual(sourceTwo, sourceOne); const beforeSourceChange = peerCommands.length;
    await peerContainer.runService(managedEntry, managedProfile, managedRuntime); const imageTwo = managedRuntime.deployedImage!;
    assert.notEqual(imageTwo, imageOne); verifiedManagedImage(imageTwo, sourceTwo);
    assert.deepEqual(await managedBody(), { source: 'source-two', built: sourceTwo, runtime: sourceTwo, flavor: 'first' });
    assert.equal(peerCommands.slice(beforeSourceChange).filter(command => command.startsWith('docker exec') && command.includes('-managed-build-')).length, 1);
    report.checks.push({ name: 'compiled-managed-new-source-rebuilds-retargeted-cache-tag', passed: true });

    report.stage = 'managed-configuration-change'; const changedProfile = { ...managedProfile, env: { OWNED_FLAVOR: 'second' } }; const beforeConfig = peerCommands.length;
    await peerContainer.runService(managedEntry, changedProfile, managedRuntime); const imageThree = managedRuntime.deployedImage!;
    assert.notEqual(imageThree, imageTwo); const changedImage = verifiedManagedImage(imageThree, sourceTwo);
    assert.notEqual(changedImage.Config.Labels['cds.managed.contract'], ownImage(imageTwo).Config.Labels['cds.managed.contract']);
    assert.deepEqual(await managedBody(), { source: 'source-two', built: sourceTwo, runtime: sourceTwo, flavor: 'second' });
    assert.equal(peerCommands.slice(beforeConfig).filter(command => command.startsWith('docker exec') && command.includes('-managed-build-')).length, 1);
    report.checks.push({ name: 'compiled-managed-changed-contract-rebuilds-instead-of-reusing-tag', passed: true });

    report.stage = 'managed-build-failure'; const beforeFailedBuild = await managedBody(); const protectedManagedId = docker(['inspect', '--format', '{{.Id}}', managedRuntime.containerName]);
    await assert.rejects(peerContainer.runService(managedEntry, { ...changedProfile, managedBuild: { ...changedProfile.managedBuild!, buildCommand: 'exit 17' } }, managedRuntime), /managed 构建失败/);
    assert.equal(docker(['inspect', '--format', '{{.Id}}', managedRuntime.containerName]), protectedManagedId); assert.deepEqual(await managedBody(), beforeFailedBuild);
    assert.equal(docker(['ps', '-aq', '--filter', `name=${owner}-managed-managed-build-`]), '');
    report.checks.push({ name: 'compiled-managed-build-failure-preserves-current-http-and-cleans-owned-builder', passed: true });

    report.stage = 'explicit-source-policy'; const beforeMissing = peerCommands.length; let sourceFallbackCalls = 0;
    const missingProfile = { ...changedProfile, managedBuild: undefined, localArtifact: false, prebuiltImage: true, command: '', dockerImage: `${registry}/owned-unpublished:sha-${sourceTwo}`, sourceFallbackProfile: changedProfile };
    await assert.rejects(peerContainer.runService(managedEntry, missingProfile, managedRuntime, undefined, undefined,
      { artifactCommitSha: sourceTwo, onSourceCompileFallback: async () => { sourceFallbackCalls++; } }), /部署未转为源码编译/);
    assert.equal(sourceFallbackCalls, 0); assert.equal(peerCommands.slice(beforeMissing).some(command => /^git |^docker (cp|exec|commit|create|run)/.test(command)), false);
    assert.equal(docker(['inspect', '--format', '{{.Id}}', managedRuntime.containerName]), protectedManagedId); assert.deepEqual(await managedBody(), beforeFailedBuild);
    report.checks.push({ name: 'compiled-missing-prebuilt-does-not-start-hidden-source-or-remove-old-http', passed: true });

    report.stage = 'local-version-content-restore'; const restoredProfile = versions.materializeProfiles(versionOne, [changedProfile])[0];
    assert.equal(restoredProfile.localArtifact, true); assert.equal(restoredProfile.dockerImage, imageOne);
    const beforeRestore = peerCommands.length; await peerContainer.runService(managedEntry, restoredProfile, managedRuntime, undefined, undefined, { artifactCommitSha: sourceOne });
    assert.equal(managedRuntime.deployedImage, imageOne); assert.equal(ownImage(artifactTag).Id, imageThree);
    assert.equal(peerCommands.slice(beforeRestore).some(command => /^git |^docker (cp|exec|commit)/.test(command)), false);
    assert.deepEqual(await managedBody(), { source: 'source-one', built: sourceOne, runtime: sourceOne, flavor: 'second' });
    report.checks.push({ name: 'compiled-local-version-restores-old-fixed-content-with-current-runtime-environment-without-source', passed: true });
    report.actualManagedProducerPolicyVerified = true; report.actualLocalVersionContentRestoreVerified = true;
    report.managedPolicy = { toolRevision: head, sourceOne, sourceTwo, imageOne, imageTwo, imageThree, reusableVersionId: versionOne.id,
      explicitSourceOnly: true, sourceBuildRuntimeIdentitiesMatch: true, originalCacheTagNowPointsToImageThree: true,
      currentRuntimeEnvironmentRetainedOnContentRestore: true, fullConfigurationRollbackVerified: false, readyBeforeOldCutVerified: false, stageFairnessAndHardLimitsVerified: false };
    report.verdict = 'passed';
  } catch (error) { report.error = { name: (error as Error).name, message: String((error as Error).message).slice(0, 1500) }; throw error;
  } finally {
    const cleanupErrors: string[] = [];
    if (masterServer) await new Promise<void>(resolve => masterServer!.close(error => { if (error) cleanupErrors.push(String(error)); resolve(); }));
    if (flushMaster) await flushMaster().catch(error => cleanupErrors.push(String(error)));
    if (peerServer) await new Promise<void>(resolve => peerServer!.close(error => { if (error) cleanupErrors.push(String(error)); resolve(); }));
    // 即使路由在返回前失败也按自有标签发现并收尾其已创建容器。
    try {
      for (const id of docker(['ps', '-aq', '--no-trunc', '--filter', `label=cds.acceptance.owner=${owner}`]).split('\n').filter(Boolean)) if (!ownedIds.includes(id)) { ownedView(id); ownedIds.push(id); }
    } catch (error) { cleanupErrors.push(String(error)); }
    if (secondaryDaemon && secondaryRuntime) { try {
      const view = JSON.parse(secondary(['inspect', secondaryRuntime]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner);
      secondary(['rm', '-f', secondaryRuntime]); assert.equal(secondary(['ps', '-aq']), ''); report.secondaryRuntimeRemoved = true;
    } catch (error) { cleanupErrors.push(String(error)); report.secondaryRuntimeRemoved = false; } }
    await shell.close().catch(error => cleanupErrors.push(String(error)));
    for (const id of ownedIds.reverse()) { try { ownedView(id); docker(['rm', '-f', id]); } catch (error) { cleanupErrors.push(String(error)); } }
    report.ownedContainersRemoved = cleanupErrors.length === 0;
    if (secondaryDaemon) { try { report.secondaryDaemonRemoved = docker(['ps', '-aq', '--no-trunc', '--filter', `id=${secondaryDaemon}`]) === ''; assert.equal(report.secondaryDaemonRemoved, true); } catch (error) { cleanupErrors.push(String(error)); } }
    for (const volume of ownedVolumes.reverse()) { try {
      assert.equal(JSON.parse(docker(['volume', 'inspect', volume]))[0].Labels['cds.acceptance.owner'], owner); docker(['volume', 'rm', volume]);
      if (volume === secondaryVolume) report.secondaryDataRemoved = true;
    } catch (error) { cleanupErrors.push(String(error)); if (volume === secondaryVolume) report.secondaryDataRemoved = false; } }
    try { assert.equal(docker(['volume', 'ls', '-q', '--filter', `label=cds.acceptance.owner=${owner}`]), ''); report.ownedVolumesRemoved = true; }
    catch (error) { cleanupErrors.push(String(error)); report.ownedVolumesRemoved = false; }

    if (peerNetwork) { try { const view = JSON.parse(docker(['network', 'inspect', peerNetwork]))[0]; assert.equal(view.Labels['cds.acceptance.owner'], owner); docker(['network', 'rm', peerNetwork]); report.ownedNetworkRemoved = true; } catch (error) { cleanupErrors.push(String(error)); report.ownedNetworkRemoved = false; } }
    // managed commit may succeed before later verification fails: discover inherited owner labels too.
    try { for (const id of docker(['image', 'ls', '-aq', '--no-trunc', '--filter', `label=cds.acceptance.owner=${owner}`]).split('\n').filter(Boolean)) {
      const view = JSON.parse(docker(['image', 'inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); imageIds.add(view.Id);
    } } catch (error) { cleanupErrors.push(String(error)); }
    for (const id of [...imageIds].reverse()) { try { const view = JSON.parse(docker(['image', 'inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); docker(['image', 'rm', '-f', id]); } catch (error) { cleanupErrors.push(String(error)); } }
    report.ownedImagesRemoved = cleanupErrors.length === 0;
    try { await fs.rm(temp, { recursive: true, force: true }); report.isolatedFilesRemoved = true; }
    catch (error) { cleanupErrors.push(String(error)); }
    if (previousIsolation === undefined) delete process.env.CDS_BRANCH_NETWORK_ISOLATION; else process.env.CDS_BRANCH_NETWORK_ISOLATION = previousIsolation;
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext !== undefined) process.env.DOCKER_CONTEXT = previousContext;
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.verdict = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
await main();
