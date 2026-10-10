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
import { ContainerService } from '../src/services/container.js';
import { collectContainerDiagnostics, DockerEventMonitor } from '../src/services/container-diagnostics.js';
import { createJanitorDockerAdapters } from '../src/services/janitor.js';
import { InfraLifecycleWatcher } from '../src/services/infra-lifecycle-watcher.js';
import { ObservationStreamExecutor } from '../src/services/observation-stream-executor.js';
import { shellQuoteArg } from '../src/services/secure-database-cli.js';
import type { CdsConfig } from '../src/types.js';

const sourcePaths = ['src/services/isolated-shell-executor.ts', 'src/services/observation-stream-executor.ts', 'src/services/docker-observation-event-stream.ts', 'src/services/container-log-stream-hub.ts', 'src/services/container-log-stream-response.ts', 'src/services/bounded-log-tail.ts', 'src/services/bounded-sse-writer.ts', 'src/routes/branches.ts', 'src/services/infra-lifecycle-watcher.ts', 'src/services/observation-process.ts', 'src/services/observation-executor-process.ts', 'src/services/observation-process-launcher.ts', 'src/services/observation-process-group.ts', 'src/services/shell-executor.ts', 'src/services/janitor.ts', 'src/services/secure-database-cli.ts', 'src/services/container.ts', 'src/services/container-diagnostics.ts', 'src/index.ts', 'src/types.ts'];
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
  const shell = new module.IsolatedShellExecutor(new ShellExecutor(), { concurrency: 2, maxQueued: 16 });
  const streamModule = compiled ? await import(new URL('../dist/services/observation-stream-executor.js', import.meta.url).href) as typeof import('../src/services/observation-stream-executor.js') : { ObservationStreamExecutor };
  const startupStreams = new streamModule.ObservationStreamExecutor(2);
  const eventStreams = new streamModule.ObservationStreamExecutor(2);
  const userLogStreams = new streamModule.ObservationStreamExecutor(2);
  const logHubModule = compiled ? await import(new URL('../dist/services/container-log-stream-hub.js', import.meta.url).href) as typeof import('../src/services/container-log-stream-hub.js') : { ContainerLogStreamHub };
  const userLogHub = new logHubModule.ContainerLogStreamHub(userLogStreams);
  const logResponseModule = compiled ? await import(new URL('../dist/services/container-log-stream-response.js', import.meta.url).href) as typeof import('../src/services/container-log-stream-response.js') : { serveContainerLogStream };
  const logWriterModule = compiled ? await import(new URL('../dist/services/bounded-sse-writer.js', import.meta.url).href) as typeof import('../src/services/bounded-sse-writer.js') : { ssePendingBudget };
  let logServer: http.Server | undefined;
  const logRequests: http.ClientRequest[] = [];
  const archivedLogBytes: number[] = [];
  const diagnosticsModule = compiled ? await import(new URL('../dist/services/container-diagnostics.js', import.meta.url).href) as typeof import('../src/services/container-diagnostics.js') : { collectContainerDiagnostics, DockerEventMonitor };
  const infraModule = compiled ? await import(new URL('../dist/services/infra-lifecycle-watcher.js', import.meta.url).href) as typeof import('../src/services/infra-lifecycle-watcher.js') : { InfraLifecycleWatcher };
  const managedActions: string[] = [];
  const eventWarnings: string[] = [];
  const eventStore = { record: (record: { action?: string; message?: string }) => { if (record.action?.includes('warning') && eventWarnings.length < 10) eventWarnings.push((record.message || '').slice(0, 200)); } };
  const dockerEvents = new diagnosticsModule.DockerEventMonitor(shell, eventStore, event => {
    if (event.containerName === name && event.attrs['cds.acceptance.owner'] === owner && managedActions.length < 20) managedActions.push(event.action);
  }, eventStreams);
  const infraEvents = new infraModule.InfraLifecycleWatcher({ streams: eventStreams, serverEventLogStore: eventStore });
  const container = new ContainerService(shell, { repoRoot: temp, worktreeBase: temp, dockerNetwork: 'bridge', sharedEnv: {}, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'isolated' } } as CdsConfig, undefined, undefined, startupStreams, userLogHub);
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
    report.stage = 'independent-process-prewarm';
    await Promise.all([shell.start(), startupStreams.start(), eventStreams.start(), userLogStreams.start()]);
    report.streamWarmStats = startupStreams.getStats();
    report.eventWarmStats = eventStreams.getStats();
    report.userLogWarmStats = userLogStreams.getStats();
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
    report.eventReceipt = { managedOwnedActions: managedActions, infraOwnedEvents: infraEvents.getEvents(name).map(event => ({ event: event.event, exitCode: event.exitCode })), warnings: eventWarnings, observed };
    assert.ok(observed);
    assert.equal(await container.isRunning(id!), true);
    await Promise.all([dockerEvents.stop(), infraEvents.stop()]);
    assert.equal(eventStreams.getStats().admitted, 0);
    report.eventReceipt.drainedStats = eventStreams.getStats();
    report.checks.push({ name: 'compiled-owned-docker-events-independent-streams-and-drain', passed: true });



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
    try { await Promise.all([dockerEvents.stop(), infraEvents.stop(), userLogHub.close()]); }
    catch { report.verdict = 'failed'; process.exitCode = 1; }
    const processRoots = [shell.getStats().factoryPid, ...shell.getStats().actors.map(actor => actor.pid), startupStreams.getStats().factoryPid, ...startupStreams.getStats().actors.map(actor => actor.pid), eventStreams.getStats().factoryPid, ...eventStreams.getStats().actors.map(actor => actor.pid), userLogStreams.getStats().factoryPid, ...userLogStreams.getStats().actors.map(actor => actor.pid)].filter((pid): pid is number => !!pid);
    try {
      await Promise.all([shell.close(), startupStreams.close(), eventStreams.close(), userLogStreams.close()]);
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
