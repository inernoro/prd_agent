import assert from 'node:assert/strict';
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
  state: await import(new URL('../dist/services/state.js', import.meta.url).href) as typeof import('../src/services/state.js'),
  runs: await import(new URL('../dist/services/deployment-run.js', import.meta.url).href) as typeof import('../src/services/deployment-run.js'),
  coordinator: await import(new URL('../dist/services/branch-operation-coordinator.js', import.meta.url).href) as typeof import('../src/services/branch-operation-coordinator.js'),
  input: await import(new URL('../dist/services/deployment-input.js', import.meta.url).href) as typeof import('../src/services/deployment-input.js'),
  wait: await import(new URL('../dist/services/artifact-admission-wait.js', import.meta.url).href) as typeof import('../src/services/artifact-admission-wait.js'),
  artifacts: await import(new URL('../dist/services/artifact-admission.js', import.meta.url).href) as typeof import('../src/services/artifact-admission.js'),
  container: await import(new URL('../dist/services/container.js', import.meta.url).href) as typeof import('../src/services/container.js'),
  shell: await import(new URL('../dist/services/shell-executor.js', import.meta.url).href) as typeof import('../src/services/shell-executor.js'),
  isolated: await import(new URL('../dist/services/isolated-shell-executor.js', import.meta.url).href) as typeof import('../src/services/isolated-shell-executor.js'),
});
const sourcePaths = ['src/services/artifact-admission.ts', 'src/services/artifact-admission-wait.ts',
  'src/services/branch-operation-coordinator.ts', 'src/services/deployment-input.ts', 'src/services/deployment-intent.ts',
  'src/services/deployment-run.ts', 'src/services/state.ts', 'src/services/container.ts', 'src/services/isolated-shell-executor.ts',
  'src/services/shell-executor.ts', 'scripts/artifact-admission-drill.ts'];

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
    scope: 'compiled artifact checker and durable queue; real owned loopback registry, HTTP old fixture and SIGKILL; no full application deployment or public performance acceptance',
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]))),
    actualRegistryPublishResumeVerified: false, actualApplicationDeploymentVerified: false, performanceVerified: false,
    ownedContainersRemoved: false, ownedImagesRemoved: false, isolatedFilesRemoved: false };
  const m = await modules();
  const previousHost = process.env.DOCKER_HOST, previousContext = process.env.DOCKER_CONTEXT;
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
    await fs.writeFile(path.join(context, 'server.cjs'), "const http=require('node:http'),fs=require('node:fs');http.createServer((_req,res)=>{res.setHeader('Content-Type','text/plain');res.end(fs.readFileSync('/www/index.html','utf8'));}).listen(8080,'0.0.0.0');");
    await fs.writeFile(path.join(context, 'Dockerfile'), `FROM ${fixtureImage}\nLABEL cds.acceptance.owner="${owner}" org.opencontainers.image.revision="${head}"\nCOPY index.html /www/index.html\nCOPY server.cjs /server.cjs\nCMD ["node", "/server.cjs"]\n`);
    docker(['build', '--network', 'none', '-t', ref, context]);
    const image = JSON.parse(docker(['image', 'inspect', ref]))[0]; assert.equal(image.Config.Labels['cds.acceptance.owner'], owner);
    imageIds.add(image.Id); docker(['push', ref]);
  };
  try {
    await shell.start(); report.stage = 'registry-ready'; docker(['pull', 'registry:2']); docker(['pull', fixtureImage]);
    const registryId = start('registry', ['--cpus', '0.5', '--memory', '128m', '-p', '127.0.0.1::5000', 'registry:2']);
    const port = await publishedPort(registryId, '5000/tcp');
    const registry = `127.0.0.1:${port}`; await waitHttp(`http://${registry}/v2/`);
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
    report.verdict = 'passed';
  } catch (error) { report.error = { name: (error as Error).name, message: String((error as Error).message).slice(0, 1500) }; throw error;
  } finally {
    const cleanupErrors: string[] = [];
    await shell.close().catch(error => cleanupErrors.push(String(error)));
    for (const id of ownedIds.reverse()) { try { ownedView(id); docker(['rm', '-f', id]); } catch (error) { cleanupErrors.push(String(error)); } }
    report.ownedContainersRemoved = cleanupErrors.length === 0;
    for (const id of imageIds) { try { const view = JSON.parse(docker(['image', 'inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); docker(['image', 'rm', '-f', id]); } catch (error) { cleanupErrors.push(String(error)); } }
    report.ownedImagesRemoved = cleanupErrors.length === 0;
    await fs.rm(temp, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext !== undefined) process.env.DOCKER_CONTEXT = previousContext;
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.verdict = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
await main();
