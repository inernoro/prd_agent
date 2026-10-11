import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import type { CdsConfig, IShellExecutor, ExecOptions } from '../src/types.js';

const sourcePaths = ['src/routes/branches.ts', 'src/services/container.ts', 'src/services/state.ts',
  'src/services/branch-operation-coordinator.ts', 'src/services/deployment-run.ts', 'src/services/deployment-intent.ts',
  'src/services/deployment-input.ts', 'src/services/deployment-version.ts', 'src/services/artifact-admission.ts',
  'src/services/artifact-admission-wait.ts', 'src/services/worktree.ts', 'src/services/deploy-runtime.ts',
  'src/services/build-gate.ts', 'src/services/deploy-layer-runner.ts', 'src/services/env-provenance.ts',
  'src/services/isolated-shell-executor.ts', 'src/services/shell-executor.ts', 'scripts/deployment-queue-drill.ts'];
const m = {
  router: await import(new URL('../dist/routes/branches.js', import.meta.url).href) as typeof import('../src/routes/branches.js'),
  container: await import(new URL('../dist/services/container.js', import.meta.url).href) as typeof import('../src/services/container.js'),
  state: await import(new URL('../dist/services/state.js', import.meta.url).href) as typeof import('../src/services/state.js'),
  coordinator: await import(new URL('../dist/services/branch-operation-coordinator.js', import.meta.url).href) as typeof import('../src/services/branch-operation-coordinator.js'),
  runs: await import(new URL('../dist/services/deployment-run.js', import.meta.url).href) as typeof import('../src/services/deployment-run.js'),
  versions: await import(new URL('../dist/services/deployment-version.js', import.meta.url).href) as typeof import('../src/services/deployment-version.js'),
  worktree: await import(new URL('../dist/services/worktree.js', import.meta.url).href) as typeof import('../src/services/worktree.js'),
  shell: await import(new URL('../dist/services/shell-executor.js', import.meta.url).href) as typeof import('../src/services/shell-executor.js'),
  isolated: await import(new URL('../dist/services/isolated-shell-executor.js', import.meta.url).href) as typeof import('../src/services/isolated-shell-executor.js'),
};
async function until<T>(check: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) { const result = await check(); if (result !== undefined) return result;
    if (performance.now() >= deadline) throw new Error('Owned queue-drill observation deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 100)); }
}
async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux'); assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const owner = `cds_queue_${randomBytes(8).toString('hex')}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-queue-ci-')); await fs.chmod(temp, 0o700);
  const output = path.resolve('queue-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); assert.match(head, /^[a-f0-9]{40}$/);
  const docker = (args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8', timeout: 120_000 }).trim();
  const report: any = { schema: 1, head, owner, startedAt: new Date().toISOString(), verdict: 'failed', checks: [],
    scope: 'compiled branch deploy and per-service queue with real owned Git, images, containers and HTTP; controlled pause before first owned docker run; no full index boot, remote executor, storm, safe cutover or performance acceptance',
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]))),
    actualBranchDeploymentQueueVerified: false, actualApplicationDeploymentVerified: false, performanceVerified: false,
    ownedContainersRemoved: false, ownedImagesRemoved: false, ownedNetworkRemoved: false, isolatedFilesRemoved: false };
  const previousHost = process.env.DOCKER_HOST, previousContext = process.env.DOCKER_CONTEXT, previousIsolation = process.env.CDS_BRANCH_NETWORK_ISOLATION;
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock'; delete process.env.DOCKER_CONTEXT; process.env.CDS_BRANCH_NETWORK_ISOLATION = '0';
  const pool = new m.isolated.IsolatedShellExecutor(new m.shell.ShellExecutor(), { isolatedLane: 'operation', concurrency: 3, reservedCleanup: 1, maxQueued: 16, maxBytes: 2 * 1024 * 1024, reservedCleanupBytes: 64 * 1024 });
  const commands: string[] = [], commandReceipts: unknown[] = []; let held = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const shell: IShellExecutor = { exec: async (command: string, options?: ExecOptions) => {
    if (/^docker (?:system|container|image|network) prune\b/.test(command)) throw new Error('Global prune forbidden in owned queue drill');
    if (options?.cwd) assert.ok(path.resolve(options.cwd).startsWith(temp + path.sep));
    if (/^docker (?:run|create|rm|stop|start|restart|cp|exec|commit|network (?:create|rm|disconnect|connect)|image rm)\b/.test(command)) assert.ok(command.includes(owner), 'Docker mutation must target the owned namespace');
    if (/^(?:kill|killall|pkill|fuser).*\b/.test(command)) throw new Error('Unqualified process mutation forbidden');
    if (/^rm\b/.test(command)) assert.ok(command.includes(temp + path.sep));
    if (/^git\b/.test(command)) assert.ok(!command.includes('--global'));
    commands.push(command);
    if (!held && /^docker run -d\b/.test(command)) { assert.ok(command.includes(owner)); held = true; await gate; }
    const result = await pool.exec(command, options);
    if (commandReceipts.length < 256) commandReceipts.push({ command, cwd: options?.cwd, exitCode: result.exitCode, stderrTail: result.exitCode ? result.stderr.slice(-1500) : undefined });
    return result;
  } };
  const stateFile = path.join(temp, 'state.json'); const state = new m.state.StateService(stateFile); state.load();
  const coordinator = new m.coordinator.BranchOperationCoordinator(); const runs = new m.runs.DeploymentRunService(state);
  let server: http.Server | undefined, network: string | undefined; const images = new Set<string>();
  const drains: Promise<unknown>[] = [];
  try {
    await pool.start();
    const repo = path.join(temp, 'repo'); await fs.mkdir(repo);
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15_000 }).trim();
    git(['init', '--quiet', '--initial-branch=owned-main']); const sources: string[] = [];
    for (let n = 1; n <= 3; n++) { await fs.writeFile(path.join(repo, 'source.txt'), `source-${n}`); git(['add', '.']);
      git(['-c', 'user.name=CDS隔离验收', '-c', 'user.email=owned@example.invalid', 'commit', '--quiet', '-m', `隔离队列源码第${n}版`]); sources.push(git(['rev-parse', 'HEAD'])); }
    const [one, two, three] = sources; sources.forEach(sha => assert.match(sha, /^[a-f0-9]{40}$/));
    const origin = path.join(temp, 'origin.git'); git(['clone', '--quiet', '--bare', repo, origin]); git(['remote', 'add', 'origin', origin]); git(['fetch', '--quiet', 'origin', 'owned-main']);
    network = `${owner}-network`; docker(['network', 'create', '--label', `cds.acceptance.owner=${owner}`, network]);
    const imagePrefix = `owned-${owner}`;
    for (const source of sources) {
      const context = path.join(temp, source); await fs.mkdir(context);
      await fs.writeFile(path.join(context, 'server.cjs'), `require('node:http').createServer((_q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({service:process.env.SERVICE_NAME,source:'${source}',runtime:process.env.CDS_COMMIT_SHA}));}).listen(8080,'0.0.0.0');`);
      await fs.writeFile(path.join(context, 'Dockerfile'), `FROM node:22-alpine\nLABEL cds.acceptance.owner="${owner}" org.opencontainers.image.revision="${source}"\nCOPY server.cjs /app/server.cjs\nEXPOSE 8080\nCMD ["node","/app/server.cjs"]\n`);
      const tag = `${imagePrefix}:sha-${source}`; docker(['build', '--quiet', '-t', tag, context]);
      const view = JSON.parse(docker(['image', 'inspect', tag]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); images.add(view.Id);
    }
    const config: CdsConfig = { repoRoot: repo, worktreeBase: path.join(temp, 'worktrees'), masterPort: 0, workerPort: 5500, executorPort: 5501,
      dockerNetwork: network, mode: 'standalone', portStart: 10001, rootDomains: ['invalid'], previewDomain: 'invalid', sharedEnv: {}, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'owned-queue' } };
    const projectId = owner, branchId = `${owner}-branch`, now = new Date().toISOString();
    state.addProject({ id: projectId, slug: owner.replaceAll('_', '-'), name: '隔离队列项目', kind: 'git', legacyFlag: true, dockerNetwork: network, createdAt: now, updatedAt: now });
    for (const role of ['api', 'web']) state.addBuildProfile({ id: role, projectId, name: role, dockerImage: imagePrefix + ':sha-${CDS_COMMIT_SHA}',
      prebuiltImage: true, localArtifact: true, workDir: '.', command: '', containerPort: 8080, env: { SERVICE_NAME: role }, readinessProbe: { timeoutSeconds: 30 } });
    const worktreeService = new m.worktree.WorktreeService(shell);
    const branchWorktree = m.worktree.WorktreeService.worktreePathFor(config.worktreeBase, projectId, branchId);
    await fs.mkdir(path.dirname(branchWorktree), { recursive: true });
    await worktreeService.create(repo, 'owned-main', branchWorktree);
    const initialGit = await shell.exec('git rev-parse HEAD', { cwd: branchWorktree }); assert.equal(initialGit.exitCode, 0); assert.equal(initialGit.stdout.trim(), three);
    report.initialWorktree = { createdByOriginalService: true, canonicalProjectPath: true, head: initialGit.stdout.trim() };
    state.addBranch({ id: branchId, projectId, branch: 'owned-main', githubCommitSha: three, worktreePath: branchWorktree, status: 'idle', createdAt: now, services: {} }); await state.flush();
    const app = express(); app.use(express.json()); app.use('/api', m.router.createBranchRouter({ stateService: state, worktreeService,
      containerService: new m.container.ContainerService(shell, config), shell, config, branchOperationCoordinator: coordinator, deploymentRunService: runs, deploymentVersionService: new m.versions.DeploymentVersionService(state) }));
    server = await new Promise<http.Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    config.masterPort = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${config.masterPort}`;
    const post = (endpoint: string, commitSha: string, trigger = 'webhook') => fetch(`${url}/api/branches/${branchId}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CDS-Trigger': trigger }, body: JSON.stringify({ commitSha }), signal: AbortSignal.timeout(90_000) });
    let initialResponse: Response | undefined, initialError: unknown;
    const firstPromise = post('/deploy', one, 'manual').then(response => { initialResponse = response; return response; }, error => { initialError = error; throw error; }); firstPromise.catch(() => {});
    await until(async () => {
      if (initialError) throw initialError;
      if (initialResponse && initialResponse.status !== 200) { const body = await initialResponse.text(); report.initialResponse = { status: initialResponse.status, body: body.slice(0, 3000) }; throw new Error('Initial owned deployment rejected before start'); }
      const live = runs.list({ branchId })[0];
      if (live && ['failed', 'cancelled'].includes(live.status)) { report.initialRun = live; throw new Error('Initial owned deployment ended before start gate'); }
      return held ? true : undefined;
    }, 45_000);
    const first = await firstPromise; assert.equal(first.status, 200); const originalRunId = first.headers.get('x-cds-deployment-run-id'); assert.ok(originalRunId);
    const firstBody = first.text(); firstBody.catch(() => {}); drains.push(firstBody);
    const repeated = await post('/deploy', one, 'manual'); const repeatedBody = await repeated.text(); assert.ok([200, 202].includes(repeated.status), repeatedBody);
    assert.equal(repeated.headers.get('x-cds-deployment-run-id'), originalRunId);
    const queued = async (role: string, sha: string, expectedStatus: 'merged' | 'joined' = 'merged') => {
      const response = await post(`/deploy/${role}`, sha); const body = await response.text();
      assert.equal(response.status, 200, body); assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
      const complete = body.match(/event: complete\r?\ndata: ([^\r\n]+)/); assert.ok(complete, body);
      const payload = JSON.parse(complete[1]); assert.equal(payload.ok, true); assert.equal(payload.operationStatus, expectedStatus);
      assert.equal(payload.pendingCommitSha, sha); const runId = response.headers.get('x-cds-deployment-run-id'); assert.ok(runId);
      assert.equal(payload.deploymentRunId, runId); assert.equal(runs.get(runId)!.commitSha, sha); return runId;
    };
    const oldApiRun = await queued('api', two); const sameOld = await queued('api', two, 'joined'); assert.equal(sameOld, oldApiRun);
    const webRun = await queued('web', two); const latestApiRun = await queued('api', three);
    assert.equal(runs.get(oldApiRun)!.status, 'cancelled'); assert.equal(runs.get(latestApiRun)!.status, 'queued'); assert.equal(runs.get(webRun)!.status, 'queued');
    await state.flush(); const queuedDisk = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(queuedDisk.deploymentRuns[oldApiRun].status, 'cancelled'); assert.equal(queuedDisk.deploymentRuns[webRun].status, 'queued');
    report.checks.push({ name: 'actual-http-duplicates-join-original-run-and-new-api-target-cancels-only-old-api-pending', passed: true });
    release(); await firstBody;
    await until(async () => runs.get(latestApiRun)?.status === 'running' && runs.get(webRun)?.status === 'running'
      && coordinator.getActiveOperations(branchId).length === 0 && coordinator.getPendingWebhookDeploy(branchId) === undefined ? true : undefined);
    const branch = state.getBranch(branchId)!;
    const probe = async (role: string, sha: string) => { const service = branch.services[role]; assert.equal(service.status, 'running');
      const response = await fetch(`http://127.0.0.1:${service.hostPort}/`, { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { service: role, source: sha, runtime: sha });
      const view = JSON.parse(docker(['inspect', service.containerName]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner);
      assert.equal(view.HostConfig.NetworkMode, network); assert.equal(view.State.Running, true); };
    await probe('api', three); await probe('web', two);
    const runCommands = commands.filter(command => /^docker run -d\b/.test(command));
    const runtimeImages = runCommands.map(command => { const matches = command.match(/sha256:[a-f0-9]{64}/g); assert.ok(matches?.length); return matches![matches!.length - 1]; });
    const imageFor = (sha: string) => JSON.parse(docker(['image', 'inspect', `${imagePrefix}:sha-${sha}`]))[0].Id;
    assert.equal(runtimeImages.filter(image => image === imageFor(one)).length, 2);
    assert.equal(runtimeImages.filter(image => image === imageFor(two)).length, 1);
    assert.equal(runtimeImages.filter(image => image === imageFor(three)).length, 1);
    assert.equal(runs.list({ branchId }).length, 4); assert.equal(runs.get(originalRunId)!.status, 'running');
    assert.equal(runs.get(oldApiRun)!.status, 'cancelled'); assert.equal(runs.get(latestApiRun)!.commitSha, three); assert.equal(runs.get(webRun)!.commitSha, two);
    await state.flush(); const reopened = new m.state.StateService(stateFile); reopened.load(); await reopened.flush();
    assert.equal(new m.runs.DeploymentRunService(reopened).restoreQueued(new m.coordinator.BranchOperationCoordinator()).length, 0);
    report.checks.push({ name: 'compiled-branch-route-executes-four-owned-service-runs-preserving-distinct-service-targets-and-no-obsolete-api-start', passed: true });
    report.checks.push({ name: 'actual-service-http-and-cold-ledger-match-completed-original-queued-identities-with-no-replay', passed: true });
    report.tasks = { originalRunId, oldApiRun, latestApiRun, webRun, sourceOne: one, sourceTwo: two, sourceThree: three, actualDockerRuns: runCommands.length };
    report.actualBranchDeploymentQueueVerified = true; report.verdict = 'passed';
  } catch (error) { report.error = { name: (error as Error).name, message: String((error as Error).message).slice(0, 2000) }; throw error;
  } finally {
    release(); coordinator.interruptAll('owned queue drill ending', 'isolated-ci');
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await Promise.allSettled(drains); const cleanupErrors: string[] = [];
    await pool.close().catch(error => cleanupErrors.push(String(error))); await state.flush().catch(error => cleanupErrors.push(String(error)));
    try { for (const id of docker(['ps', '-aq', '--no-trunc', '--filter', `label=cds.acceptance.owner=${owner}`]).split('\n').filter(Boolean)) {
      const view = JSON.parse(docker(['inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); assert.ok(view.Name.includes(owner)); docker(['rm', '-f', id]); }
      report.ownedContainersRemoved = true;
    } catch (error) { cleanupErrors.push(String(error)); }
    try { for (const image of images) { const view = JSON.parse(docker(['image', 'inspect', image]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); docker(['image', 'rm', '-f', image]); } report.ownedImagesRemoved = true; }
    catch (error) { cleanupErrors.push(String(error)); }
    if (network) { try { const view = JSON.parse(docker(['network', 'inspect', network]))[0]; assert.equal(view.Labels['cds.acceptance.owner'], owner); docker(['network', 'rm', network]); report.ownedNetworkRemoved = true; } catch (error) { cleanupErrors.push(String(error)); } }
    try { await fs.rm(temp, { recursive: true, force: true }); report.isolatedFilesRemoved = true; } catch (error) { cleanupErrors.push(String(error)); }
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previousContext;
    if (previousIsolation === undefined) delete process.env.CDS_BRANCH_NETWORK_ISOLATION; else process.env.CDS_BRANCH_NETWORK_ISOLATION = previousIsolation;
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.verdict = 'failed'; process.exitCode = 1; }
    report.commands = commands; report.commandReceipts = commandReceipts; report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
await main();
