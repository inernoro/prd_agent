import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { runApplicationBootstrap, type ApplicationBootstrapContext } from './application-bootstrap-drill.js';

// 在外层自有容器里运行；原 index 与 Docker 发布端口在同一个网络空间，保留原分支网络隔离。
const execute = promisify(execFile);
const host = 'unix:///var/run/owned.sock';
const docker = async (args: string[], timeout = 120_000) => (await execute('docker', ['--host', host, ...args],
  { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 120_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) { const value = await read(); if (value !== undefined) return value;
    if (performance.now() >= deadline) throw new Error('完整应用自有Docker检查到期'); await sleep(300); }
}
async function availablePort(): Promise<number> {
  const server = http.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux'); assert.equal(path.resolve('.'), '/owned/source');
  const source = JSON.parse(await fs.readFile('owned-source.json', 'utf8')); assert.match(source.sourceHead, /^[a-f0-9]{40}$/); assert.match(source.owner, /^cds_app_[a-f0-9]{16}$/);
  for (const [name, hash] of Object.entries(source.hashes)) {
    assert.ok(!path.isAbsolute(name) && !name.split(path.sep).includes('..'));
    assert.equal(createHash('sha256').update(await fs.readFile(name)).digest('hex'), hash);
  }
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}'])); assert.ok(info.ID);
  assert.equal(await docker(['ps', '-aq']), ''); // 外层刚建的空守护进程，不接共享 socket。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-app-fixtures-')); await fs.chmod(root, 0o700);
  const report: any = { schema: 1, sourceHead: source.sourceHead, owner: source.owner, daemonId: info.ID, checks: [],
    startedAt: new Date().toISOString(), verdict: 'failed', genericFixtureOnly: true, representativeBusinessCiVerified: false,
    firstStageVerified: false, performanceVerified: false, abnormalRestartVerified: false, infrastructureRecoveryVerified: false,
    branchNetworkIsolationDisabled: false, noPrimaryDockerSocket: true, ownedContainersRemoved: false };
  const containers = new Set<string>(); const images = new Set<string>();
  const ownedView = async (id: string) => {
    const view = JSON.parse(await docker(['inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner); return view;
  };
  const auditNamespace = async (stage: string) => {
    assert.equal(JSON.parse(await docker(['info', '--format', '{{json .}}'])).ID, info.ID);
    const rows: any[] = [];
    for (const id of (await docker(['ps', '-aq', '--no-trunc'])).split('\n').filter(Boolean)) {
      const view = JSON.parse(await docker(['inspect', id]))[0]; assert.equal(view.Id, id);
      const owner = view.Config.Labels?.['cds.acceptance.owner'] || null;
      assert.ok(!owner || owner === source.owner, '独占空间发现其他归属，不猜测删除');
      rows.push({ id, name: view.Name, image: view.Image, created: view.Created, status: view.State.Status,
        running: view.State.Running, pid: view.State.Pid, owner, networkMode: view.HostConfig.NetworkMode,
        networks: Object.keys(view.NetworkSettings.Networks || {}),
        namespaceOwnership: 'initial-empty-private-daemon-and-volume; unchanged-daemon-id; no-primary-socket' });
    }
    report.namespaceInventories ||= []; report.namespaceInventories.push({ stage, at: new Date().toISOString(), daemonId: info.ID, rows }); return rows;
  };
  const processSnapshot = async (stage: string) => {
    const text = (await execute('ps', ['-eo', 'pid,ppid,pgid,stat,rss,comm'], { encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 })).stdout;
    report.processSnapshots ||= []; report.processSnapshots.push({ stage, at: new Date().toISOString(), text });
  };
  const eventSnapshot = async (stage: string) => {
    // 所有事件均来自独占daemon；只保存身份/行为，舍弃任意标签与环境内容。
    const from = String(Math.floor(new Date(report.startedAt).getTime() / 1000));
    const to = String(Math.floor(Date.now() / 1000) + 1);
    const text = await docker(['events', '--since', from, '--until', to, '--format', '{{json .}}'], 10_000);
    const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(events.length <= 4096, '独占事件证据超过上限，不静默截断');
    report.namespaceEventSnapshots ||= []; report.namespaceEventSnapshots.push({ stage, at: new Date().toISOString(), events: events.map(event => ({
      time: event.time, timeNano: event.timeNano, type: event.Type, action: event.Action, id: event.Actor?.ID,
      name: event.Actor?.Attributes?.name || null, image: event.Actor?.Attributes?.image || null,
      owner: event.Actor?.Attributes?.['cds.acceptance.owner'] || null })) });
  };
  const run = async (name: string, args: string[]) => {
    const id = await docker(['run', '-d', '--label', `cds.acceptance.owner=${source.owner}`, '--name', `${source.owner}-${name}`, ...args]);
    assert.match(id, /^[a-f0-9]{64}$/); containers.add(id); await ownedView(id); return id;
  };
  const build = async (role: string, sha: string, registry: string) => {
    const context = path.join(root, `${role}-${sha}`); await fs.mkdir(context);
    await fs.writeFile(path.join(context, 'server.cjs'), `require('node:http').createServer((_q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({service:process.env.SERVICE_NAME,source:'${sha}',runtime:process.env.CDS_COMMIT_SHA}));}).listen(8080,'0.0.0.0');`);
    await fs.writeFile(path.join(context, 'Dockerfile'), `FROM node:22-alpine\nLABEL cds.acceptance.owner="${source.owner}" org.opencontainers.image.revision="${sha}" cds.acceptance.role="${role}"\nCOPY server.cjs /app/server.cjs\nEXPOSE 8080\nCMD ["node","/app/server.cjs"]\n`);
    const reference = `${registry}/owned-${role}:sha-${sha}`; await docker(['build', '--network', 'none', '--quiet', '-t', reference, context]);
    const view = JSON.parse(await docker(['image', 'inspect', reference]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner);
    assert.equal(view.Config.Labels['org.opencontainers.image.revision'], sha); images.add(view.Id); await docker(['push', reference]);
    report.publishedImages ||= []; report.publishedImages.push({ role, sha, reference, id: view.Id, repoDigests: JSON.parse(await docker(['image', 'inspect', reference]))[0].RepoDigests,
      os: view.Os, architecture: view.Architecture });
  };
  try {
    report.stage = 'owned-fixtures-ready';
    for (const image of ['mongo:7.0', 'registry:2', 'node:22-alpine']) await docker(['pull', image]);
    const mongoPort = await availablePort(), registryPort = await availablePort(); assert.notEqual(mongoPort, registryPort);
    await run('mongo', ['--network', 'host', '--cpus', '0.5', '--memory', '768m', 'mongo:7.0', 'mongod', '--bind_ip', '127.0.0.1', '--port', String(mongoPort), '--wiredTigerCacheSizeGB', '0.25']);
    await run('registry', ['--network', 'host', '--cpus', '0.25', '--memory', '128m', '-e', `REGISTRY_HTTP_ADDR=127.0.0.1:${registryPort}`, 'registry:2']);
    const registry = `127.0.0.1:${registryPort}`;
    await until(async () => { try { return (await fetch(`http://${registry}/v2/`, { signal: AbortSignal.timeout(1000) })).status === 200 ? true : undefined; } catch { return undefined; } });
    await until(async () => { const probe = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, { serverSelectionTimeoutMS: 500 });
      try { await probe.connect(); return (await probe.db('admin').command({ hello: 1 })).isWritablePrimary ? true : undefined; }
      catch { return undefined; } finally { await probe.close(); } });
    await runApplicationBootstrap({ sourceHead: source.sourceHead, mongoUri: `mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, dockerHost: host, output: '/owned/output',
      exercise: async (context: ApplicationBootstrapContext) => {
        const { request, requestRaw } = context;
        report.stage = 'real-project-create';
        const compose = 'services:\n' + ['api', 'web', 'worker'].map(role => `  ${role}:\n    image: "${registry}/owned-${role === 'web' ? 'web' : 'api'}:sha-\${CDS_COMMIT_SHA}"\n    ports: ["8080"]\n    environment:\n      SERVICE_NAME: "${role}"\n    labels:\n      cds.prebuilt-image: "true"\n      cds.subdomain: "${role}"\n      cds.readiness-path: "/"\n      cds.readiness-timeout: "30"\n`).join('');
        const created = await request('/api/projects', 'POST', { name: '完整应用隔离部署前提', slug: source.owner.replaceAll('_', '-'), composeYaml: compose,
          projectFiles: [{ relativePath: 'marker.txt', content: 'old-fixture' }] });
        assert.equal(created.status, 201, created.text); assert.equal(created.json.sandbox, true); const projectId = created.json.project.id; assert.ok(projectId);
        const projectRepo = path.join(context.root, 'repos', projectId); assert.ok((await fs.stat(projectRepo)).isDirectory());
        const git = async (args: string[]) => (await execute('/usr/bin/git', ['-C', projectRepo, ...args], { encoding: 'utf8', timeout: 5000 })).stdout.trim();
        const oldSha = await git(['rev-parse', 'HEAD']); assert.match(oldSha, /^[a-f0-9]{40}$/);
        const profilesResponse = await request(`/api/build-profiles?project=${encodeURIComponent(projectId)}`); assert.equal(profilesResponse.status, 200);
        const profiles = profilesResponse.json.profiles; assert.equal(profiles.length, 3);
        assert.equal(profiles.every((p: any) => p.prebuiltImage === true && !p.localArtifact && !p.managedBuild), true);
        const branchResponse = await request('/api/branches', 'POST', { projectId, branch: 'main' }); assert.equal(branchResponse.status, 201, branchResponse.text);
        const branchId = branchResponse.json.branch.id; assert.ok(branchId); const branchPath = `/api/branches/${encodeURIComponent(branchId)}`;
        const runsPath = `/api/deployment-runs?project=${encodeURIComponent(projectId)}&branch=${encodeURIComponent(branchId)}`;
        const readRuns = async () => { const response = await request(runsPath); assert.equal(response.status, 200, response.text); report.lastRunsResponse = { status: response.status, runs: response.json.runs }; return response.json.runs as any[]; };
        const branch = async () => { const response = await request(branchPath); assert.equal(response.status, 200, response.text); return response.json.branch; };
        report.project = { projectId, branchId, profiles: profiles.map((p: any) => ({ id: p.id, prebuiltImage: p.prebuiltImage, dockerImage: p.dockerImage })), sourceOld: oldSha };
        report.checks.push({ name: 'original-authenticated-project-compose-and-branch-worktree-entry', passed: true });
        const began = Math.floor(Date.now() / 1000) - 1;
        await build('api', oldSha, registry); await build('web', oldSha, registry);
        const serviceProof = async (sha: string, previousIds?: Record<string, string>) => {
          const current = await branch(); const services = Object.entries(current.services) as Array<[string, any]>; assert.equal(services.length, 3);
          const result: Record<string, any> = {};
          for (const [profileId, service] of services) {
            assert.equal(service.status, 'running'); const view = await ownedView(service.containerName); containers.add(view.Id);
            assert.equal(view.State.Running, true); assert.notEqual(view.HostConfig.NetworkMode, 'host'); assert.notEqual(view.HostConfig.NetworkMode, 'bridge');
            assert.equal(view.Config.Labels['org.opencontainers.image.revision'], sha);
            const response = await fetch(`http://127.0.0.1:${service.hostPort}/`, { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200);
            const content: any = await response.json(); assert.equal(content.source, sha); assert.equal(content.runtime, sha);
            assert.equal(content.service, profiles.find((p: any) => p.id === profileId).env.SERVICE_NAME);
            if (previousIds) assert.equal(view.Id, previousIds[profileId]);
            result[profileId] = { id: view.Id, image: view.Image, startedAt: view.State.StartedAt, hostPort: service.hostPort, network: view.HostConfig.NetworkMode, content };
          }
          return result;
        };
        report.stage = 'original-deploy-old-fixture';
        const initial = await requestRaw(`${branchPath}/deploy`, { commitSha: oldSha }); assert.equal(initial.status, 200);
        const initialId = initial.headers.get('x-cds-deployment-run-id'); assert.ok(initialId); report.initialDeployment = { id: initialId, status: initial.status, stream: (await initial.text()).slice(-32768) };
        await until(async () => { const run = (await readRuns()).find(r => r.id === initialId); if (run?.status === 'failed') throw new Error(`原应用首次部署失败: ${JSON.stringify(run).slice(0, 2000)}`); return run?.status === 'running' ? true : undefined; });
        const oldServices = await serviceProof(oldSha); report.oldServices = oldServices; await auditNamespace('original-old-services-ready');
        const oldImages = Object.values(oldServices) as any[];
        const webImage = oldImages.find(s => s.content.service === 'web').image;
        assert.equal(oldImages.filter(s => s.content.service !== 'web').every(s => s.image !== webImage), true);
        const oldIds = Object.fromEntries(Object.entries(oldServices).map(([id, value]: [string, any]) => [id, value.id]));
        await fs.writeFile(path.join(projectRepo, 'marker.txt'), 'new-fixture'); await git(['add', 'marker.txt']); await git(['commit', '-m', '隔离部署新目标']);
        const newSha = await git(['rev-parse', 'HEAD']); assert.notEqual(newSha, oldSha); assert.match(newSha, /^[a-f0-9]{40}$/); report.project.sourceNew = newSha;
        report.stage = 'missing-required-artifact-wait';
        // 原只读 API 短时样本；它不是30分钟性能窗口，全部错误原样计入。
        const reads: any[] = []; let stopReads = false;
        const sampler = (async () => { while (!stopReads) {
          for (const endpoint of ['/api/branches', runsPath, '/healthz']) {
            const started = performance.now(); try { const r = await request(endpoint); reads.push({ endpoint, at: new Date().toISOString(), status: r.status, elapsedMs: r.elapsedMs }); }
            catch (error) { reads.push({ endpoint, at: new Date().toISOString(), elapsedMs: performance.now() - started, error: String((error as Error).message) }); }
          }
          await sleep(1000);
        } })();
        try {
          const queued = await requestRaw(`${branchPath}/deploy`, { commitSha: newSha }); const text = await queued.text(); assert.ok([200, 202].includes(queued.status), text);
          const queuedId = queued.headers.get('x-cds-deployment-run-id'); assert.ok(queuedId); report.queuedDeployment = { id: queuedId, status: queued.status, stream: text.slice(-32768) };
          await until(async () => { const run = (await readRuns()).find(r => r.id === queuedId); return run?.status === 'queued' && run.phase === 'artifact-wait' ? run : undefined; });
          const duplicate = await requestRaw(`${branchPath}/deploy`, { commitSha: newSha }); const repeatedText = await duplicate.text(); assert.ok([200, 202].includes(duplicate.status), repeatedText);
          assert.equal(duplicate.headers.get('x-cds-deployment-run-id'), queuedId); report.duplicateDeployment = { id: queuedId, status: duplicate.status, stream: repeatedText.slice(-32768) };
          await serviceProof(oldSha, oldIds);
          assert.equal((await readRuns()).filter(r => r.commitSha === newSha).length, 1);
          report.checks.push({ name: 'complete-application-missing-wait-retains-real-old-http-and-duplicate-run', passed: true });
          report.stage = 'publish-all-required-and-original-watchdog-resume';
          await build('api', newSha, registry); await build('web', newSha, registry);
          await until(async () => { const run = (await readRuns()).find(r => r.id === queuedId);
            if (run?.status === 'failed') throw new Error(`原应用发布后恢复失败: ${JSON.stringify(run).slice(0, 2000)}`);
            return run?.status === 'running' ? run : undefined;
          }, 180_000);
          report.newServices = await serviceProof(newSha); report.finalRuns = await readRuns(); await auditNamespace('original-new-services-ready');
          assert.equal(report.finalRuns.filter((r: any) => r.commitSha === newSha).length, 1);
          const events = (await docker(['events', '--since', String(began), '--until', String(Math.ceil(Date.now() / 1000)), '--format', '{{json .}}']))
            .split('\n').filter(Boolean).map(line => JSON.parse(line));
          const ownedStarts = events.filter((e: any) => e.Type === 'container' && e.Action === 'start' && e.Actor?.Attributes?.['cds.acceptance.owner'] === source.owner);
          // Mongo/registry在窗口之前启动；六次实际应用start证明重复等待没有新增执行。
          assert.equal(ownedStarts.length, 6, JSON.stringify(ownedStarts)); report.actualApplicationStartEvents = ownedStarts;
          const shared = Object.values(report.newServices).filter((s: any) => s.content.service !== 'web') as any[];
          assert.equal(shared.length, 2); assert.equal(shared[0].image, shared[1].image);
          report.checks.push({ name: 'original-watchdog-resumes-confirmed-run-once-and-shared-worker-reuses-api-image', passed: true });
        } finally { stopReads = true; await sampler; report.readSamples = reads; }
        assert.ok(report.readSamples.length >= 3); assert.equal(report.readSamples.every((r: any) => r.status === 200 && !r.error), true, JSON.stringify(report.readSamples.filter((r: any) => r.status !== 200 || r.error)));
        report.checks.push({ name: 'original-list-task-and-full-health-short-window-requests-returned', passed: true });
        report.actualOwnedDockerApplicationPreflightVerified = true;
        context.report.actualOwnedDockerApplicationPreflightVerified = true;
        context.report.dockerExerciseReport = { file: 'docker-report.json', genericFixtureOnly: true, representativeBusinessCiVerified: false, shortReadSamples: report.readSamples.length };
      } });
    report.verdict = 'passed';
  } catch (error) { report.failure = { stage: report.stage, message: String((error as Error).message).slice(0, 4000) }; throw error; }
  finally {
    const cleanupErrors: string[] = [];
    try {
      // 该守护进程/卷由本批从空空间独占创建；原应用可产生无标签 helper。
      // 先保存身份并复核 daemon，再逐ID清理；这不是共享宿主的无标签容器删除策略。
      await processSnapshot('after-original-application-shutdown');
      await eventSnapshot('after-original-application-shutdown');
      const rows = await auditNamespace('after-original-application-shutdown-before-owned-namespace-cleanup');
      report.namespaceCleanup = [];
      for (const row of rows) {
        assert.equal(JSON.parse(await docker(['info', '--format', '{{json .}}'])).ID, info.ID);
        const view = JSON.parse(await docker(['inspect', row.id]))[0]; assert.equal(view.Id, row.id);
        assert.equal(view.Config.Labels?.['cds.acceptance.owner'] || null, row.owner);
        containers.add(row.id); await docker(['rm', '-f', row.id]);
        report.namespaceCleanup.push({ id: row.id, owner: row.owner, removed: true, namespaceOwnership: row.namespaceOwnership });
      }
      await processSnapshot('after-owned-container-removal');
      await eventSnapshot('after-owned-container-removal');
      const remaining = await auditNamespace('after-owned-container-removal-before-zero-assertion');
      report.remainingContainersBeforeOwnedDaemonRemoval = remaining;
      assert.equal(await docker(['ps', '-aq']), ''); assert.equal(remaining.length, 0); report.ownedContainersRemoved = true;
    } catch (error) {
      cleanupErrors.push(String(error));
      try { report.remainingContainersAfterCleanupFailure = await auditNamespace('after-cleanup-failure'); await eventSnapshot('after-cleanup-failure'); }
      catch (diagnosticError) { report.cleanupDiagnosticError = String(diagnosticError); }
    }
    try { for (const id of images) { const view = JSON.parse(await docker(['image', 'inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner); await docker(['image', 'rm', '-f', id]); } report.ownedImagesRemoved = true; }
    catch (error) { cleanupErrors.push(String(error)); }
    await fs.rm(root, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
    // 外层最后按归属销毁整个独占daemon卷；不对任何共享Docker做prune。
    try { report.remainingNetworksBeforeOwnedDaemonRemoval = JSON.parse(await docker(['network', 'ls', '--format', '{{json .}}']).then(s => '[' + s.split('\n').filter(Boolean).join(',') + ']')); }
    catch (error) { cleanupErrors.push(String(error)); }
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.verdict = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await fs.writeFile('/owned/output/docker-report.json', JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.ownedContainersRemoved, true);
}
await main().catch(error => { console.error(error instanceof Error ? error.message : '原应用Docker部署前提演练失败'); process.exitCode = 1; });
