import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
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
// Controlled failure boundary: the original CLI sends its real create body to
// this private Unix proxy. After client cancellation the same body is forwarded
// to the real, initially-empty owned daemon. It is an injected delayed request,
// not a claim that the daemon naturally reproduced the delay in this run.
export async function createProbeDaemonProxy(socketPath: string, daemonSocketPath = '/var/run/owned.sock',
  cancelBoundary: 'client-disconnect' | 'daemon-created' = 'client-disconnect') {
  const timeline: any[] = []; const sockets = new Set<net.Socket>(); const requests = new Set<http.ClientRequest>();
  const requestTimeline: any[] = []; let requestSequence = 0, traceEnabled = false, traceOverflow = 0;
  const classify = (url = '', method = '') => {
    const pathname = new URL(url, 'http://owned').pathname;
    const container = pathname.match(/\/containers\/([^/]+)\/(attach|start|wait|json)$/);
    const kind = container ? `container-${container[2] === 'json' ? 'inspect' : container[2]}`
      : /\/containers\/create$/.test(pathname) ? 'container-create'
        : method === 'DELETE' && /\/containers\/[^/]+$/.test(pathname) ? 'container-remove' : undefined;
    const target = container?.[1] || (kind === 'container-remove' ? pathname.split('/').at(-1) : undefined);
    return { kind, containerId: target && /^[a-f0-9]{64}$/.test(target) ? target : null };
  };
  const trace = (request: http.IncomingMessage) => {
    const identity = classify(request.url, request.method), requestId = ++requestSequence;
    const active = traceEnabled && Boolean(identity.kind);
    return (phase: string, fields: Record<string, unknown> = {}) => {
      if (!active) return;
      if (requestTimeline.length >= 1024) { traceOverflow++; return; }
      requestTimeline.push({ requestId, at: new Date().toISOString(), kind: identity.kind,
        method: request.method, containerId: identity.containerId, phase, ...fields });
    };
  };
  const traffic = new Map<string, { kind: string; method: string; requests: number; replies: Record<string, number>; transportErrors: number }>();
  let armed = false; let caughtResolve!: () => void; let settledResolve!: () => void;
  const caught = new Promise<void>(resolve => { caughtResolve = resolve; });
  const settled = new Promise<void>(resolve => { settledResolve = resolve; });
  let captured = false;
  const record = (phase: string, fields: Record<string, unknown> = {}) => { timeline.push({ phase, at: new Date().toISOString(), ...fields }); };
  const server = http.createServer((request, response) => {
    const observe = trace(request); observe('received');
    const kind = /\/images\/create(?:\?|$)/.test(request.url || '') ? 'image-pull'
      : /\/images\/.+\/json(?:\?|$)/.test(request.url || '') ? 'image-inspect'
        : /\/containers\/create(?:\?|$)/.test(request.url || '') ? 'container-create'
          : /\/(?:version|info|_ping)(?:\?|$)/.test(request.url || '') ? 'daemon-read' : 'other';
    const key = `${request.method}:${kind}`;
    const row = traffic.get(key) || { kind, method: request.method || '', requests: 0, replies: {}, transportErrors: 0 };
    row.requests++; traffic.set(key, row);
    const forward = (body?: Buffer, delayed = false) => {
      observe('forwarded', { delayed });
      const upstream = http.request({ socketPath: daemonSocketPath, path: request.url, method: request.method,
        headers: request.headers, timeout: 30_000 }, backend => {
        observe('response-headers', { status: backend.statusCode });
        backend.once('end', () => observe('response-ended'));
        const status = String(backend.statusCode || 0); row.replies[status] = (row.replies[status] || 0) + 1;
        if (!delayed) {
          response.writeHead(backend.statusCode || 502, backend.headers);
          // Docker wait acknowledges headers before start; buffering them until
          // the exit body arrives deadlocks the CLI before ContainerStart.
          response.flushHeaders(); backend.pipe(response);
        }
        else {
          let text = ''; backend.on('data', chunk => { text += chunk; });
          backend.on('end', () => {
            try { const view = JSON.parse(text); record('backend-create-replied', { status: backend.statusCode, containerId: view.Id ?? null });
              if (cancelBoundary === 'daemon-created' && backend.statusCode === 201 && typeof view.Id === 'string' && /^[a-f0-9]{64}$/.test(view.Id)) caughtResolve(); }
            catch { record('backend-create-invalid-reply', { status: backend.statusCode }); }
            settledResolve();
          });
        }
      });
      requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
      if (!delayed) { response.once('close', () => upstream.destroy()); response.once('error', () => upstream.destroy()); }
      upstream.once('timeout', () => { observe('transport-timeout'); upstream.destroy(new Error('owned proxy timeout')); });
      upstream.once('error', () => { observe('transport-error'); row.transportErrors++; if (delayed) { record('backend-create-transport-error'); settledResolve(); }
        else if (!response.destroyed) { if (!response.headersSent) response.statusCode = 502; response.end(); } });
      if (body) upstream.end(body); else request.pipe(upstream);
    };
    if (!armed || !/\/containers\/create(?:\?|$)/.test(request.url || '')) { forward(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => {
      const body = Buffer.concat(chunks); let config: any;
      try { config = JSON.parse(body.toString('utf8')); } catch { response.statusCode = 400; response.end(); return; }
      if (config.Labels?.['cds.agent.probe'] !== 'runtime-validation') { forward(body); return; }
      armed = false; captured = true;
      record('original-create-received', { name: new URL(request.url!, 'http://owned').searchParams.get('name'),
        operationId: config.Labels['cds.agent.probe.operation'], instanceId: config.Labels['cds.instance'], image: config.Image,
        cmdHash: createHash('sha256').update(JSON.stringify(config.Cmd)).digest('hex'),
        entrypointHash: createHash('sha256').update(JSON.stringify(config.Entrypoint)).digest('hex'),
        memoryBytes: config.HostConfig.Memory, nanoCpus: config.HostConfig.NanoCpus, pidsLimit: config.HostConfig.PidsLimit,
        readonlyRootfs: config.HostConfig.ReadonlyRootfs, autoRemove: config.HostConfig.AutoRemove, networkMode: config.HostConfig.NetworkMode });
      response.once('close', () => { record('original-client-disconnected');
        if (cancelBoundary === 'client-disconnect') setTimeout(() => {
          record('forward-after-client-disconnect'); forward(body, true);
        }, 250); });
      if (cancelBoundary === 'daemon-created') { record('forward-before-client-disconnect'); forward(body, true); }
      else caughtResolve();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, client, head) => {
    const observe = trace(request); observe('received-upgrade');
    const backend = net.connect(daemonSocketPath); sockets.add(backend); backend.once('close', () => sockets.delete(backend));
    let handshake = Buffer.alloc(0), statusRecorded = false, upstreamBytes = 0, downstreamBytes = head.length;
    backend.on('data', chunk => {
      upstreamBytes += chunk.length;
      if (!statusRecorded) {
        if (handshake.length + chunk.length > 4096) { statusRecorded = true; observe('upgrade-header-limit'); }
        else { handshake = Buffer.concat([handshake, chunk]); if (handshake.includes('\r\n\r\n')) {
          statusRecorded = true; const status = handshake.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/);
          observe('upgrade-response', { status: status ? Number(status[1]) : null }); handshake = Buffer.alloc(0);
        } }
      }
    });
    client.on('data', chunk => { downstreamBytes += chunk.length; });
    backend.once('end', () => observe('backend-ended', { upstreamBytes, downstreamBytes }));
    client.once('end', () => observe('client-input-ended', { upstreamBytes, downstreamBytes }));
    backend.once('close', () => observe('backend-closed', { upstreamBytes, downstreamBytes }));
    client.once('close', () => observe('client-closed', { upstreamBytes, downstreamBytes }));
    backend.once('connect', () => { observe('connected-upgrade'); backend.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`
      + request.rawHeaders.reduce((text, value, index, list) => index % 2 ? text : text + `${value}: ${list[index + 1]}\r\n`, '') + '\r\n');
      if (head.length) backend.write(head); client.pipe(backend).pipe(client); });
    backend.on('error', () => { observe('backend-error'); client.destroy(); });
    client.on('error', () => { observe('client-error'); backend.destroy(); }); client.on('close', () => backend.destroy());
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
  return { timeline, requestTimeline, traceOverflow: () => traceOverflow, enableTrace: () => { traceEnabled = true; },
    traffic: () => [...traffic.values()], arm: () => { armed = true; traceEnabled = true; }, caught,
    settle: () => captured ? Promise.race([settled, sleep(35_000).then(() => { throw new Error('注入的创建请求未获得终态'); })]) : Promise.resolve(),
    close: async () => { for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux'); assert.equal(path.resolve('.'), '/owned/source');
  const cancelBoundary = process.argv.includes('--cancel-after-daemon-create') ? 'daemon-created' : 'client-disconnect';
  const source = JSON.parse(await fs.readFile('owned-source.json', 'utf8')); assert.match(source.sourceHead, /^[a-f0-9]{40}$/); assert.match(source.owner, /^cds_app_[a-f0-9]{16}$/);
  for (const [name, hash] of Object.entries(source.hashes)) {
    assert.ok(!path.isAbsolute(name) && !name.split(path.sep).includes('..'));
    assert.equal(createHash('sha256').update(await fs.readFile(name)).digest('hex'), hash);
  }
  // 只读固定源码中两项常量；为真实inspect建立精确命令摘要，不记录任何容器env或任意argv。
  const capabilitySource = await fs.readFile('src/services/agent-workspace-session-runtime.ts', 'utf8');
  const codeVersion = capabilitySource.match(/export const OPEN_DESIGN_CODEX_VERSION = '([^']+)';/)?.[1];
  const prototypeSource = capabilitySource.match(/const OPEN_DESIGN_WEB_PROTOTYPE_SOURCE = '([^']+)';/)?.[1];
  const capabilityImage = capabilitySource.match(/export const OPEN_DESIGN_IMAGE = '([^']+)';/)?.[1];
  assert.ok(codeVersion && prototypeSource && capabilityImage);
  const validationScript = [
    `test "$(codex --version)" = "codex-cli ${codeVersion}"`,
    ...['SKILL.md', 'assets/template.html', 'references/layouts.md', 'references/checklist.md']
      .map(name => `test -f ${prototypeSource}/${name}`),
  ].join(' && ');
  const jsonHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const expectedCapabilityProbe = { sourceHash: createHash('sha256').update(capabilitySource).digest('hex'),
    imageReference: capabilityImage, entrypointHash: jsonHash(['/bin/sh']), cmdHash: jsonHash(['-lc', validationScript]),
    autoRemove: true, readonlyRootfs: true, networkMode: 'none', memoryBytes: 128 * 1024 * 1024,
    nanoCpus: 250_000_000, pidsLimit: 64 };
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}'])); assert.ok(info.ID);
  assert.equal(await docker(['ps', '-aq']), ''); // 外层刚建的空守护进程，不接共享 socket。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-app-fixtures-')); await fs.chmod(root, 0o700);
  const report: any = { schema: 1, sourceHead: source.sourceHead, owner: source.owner, daemonId: info.ID, checks: [],
    expectedCapabilityProbe, startedAt: new Date().toISOString(), verdict: 'failed', genericFixtureOnly: true, representativeBusinessCiVerified: false,
    firstStageVerified: false, performanceVerified: false, abnormalRestartVerified: false, infrastructureRecoveryVerified: false,
    branchNetworkIsolationDisabled: false, noPrimaryDockerSocket: true, ownedContainersRemoved: false };
  const containers = new Set<string>(); const images = new Set<string>();
  let probeProxy: Awaited<ReturnType<typeof createProbeDaemonProxy>> | undefined;
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
      const capabilityProbeIdentity = { imageReference: view.Config.Image,
        entrypointHash: jsonHash(view.Config.Entrypoint), cmdHash: jsonHash(view.Config.Cmd),
        autoRemove: view.HostConfig.AutoRemove, readonlyRootfs: view.HostConfig.ReadonlyRootfs,
        networkMode: view.HostConfig.NetworkMode, memoryBytes: view.HostConfig.Memory,
        nanoCpus: view.HostConfig.NanoCpus, pidsLimit: view.HostConfig.PidsLimit };
      const matchesDefaultRuntimeValidation = Object.entries(expectedCapabilityProbe)
        .filter(([key]) => key !== 'sourceHash')
        .every(([key, value]) => (capabilityProbeIdentity as Record<string, unknown>)[key] === value);
      rows.push({ id, name: view.Name, image: view.Image, created: view.Created, status: view.State.Status,
        running: view.State.Running, pid: view.State.Pid, owner, capabilityProbeIdentity, matchesDefaultRuntimeValidation, networkMode: view.HostConfig.NetworkMode,
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
      owner: event.Actor?.Attributes?.['cds.acceptance.owner'] || null,
      probeOperationId: event.Actor?.Attributes?.['cds.agent.probe.operation'] || null,
      probeKind: event.Actor?.Attributes?.['cds.agent.probe'] || null,
      instanceId: event.Actor?.Attributes?.['cds.instance'] || null })) });
    return report.namespaceEventSnapshots.at(-1).events as any[];
  };
  const run = async (name: string, args: string[]) => {
    const id = await docker(['run', '-d', '--label', `cds.acceptance.owner=${source.owner}`, '--name', `${source.owner}-${name}`, ...args]);
    assert.match(id, /^[a-f0-9]{64}$/); containers.add(id); await ownedView(id); return id;
  };
  const comparePinnedProbe = async (route: 'direct' | 'proxy', proxyHost: string) => {
    const name = `${source.owner}-protocol-${route}`, instanceId = `${source.owner}-protocol`;
    const operationId = createHash('sha256').update(name).digest('hex').slice(0, 32);
    const cidFile = path.join(root, `${route}.cid`), started = performance.now();
    const result: any = { route, name, instanceId, operationId, startedAt: new Date().toISOString(),
      originalProbeSpec: expectedCapabilityProbe, timeoutMs: 30_000, driverOwnedComparison: true,
      originalApplicationCapabilityVerified: false };
    (report.probeProtocolComparisons ??= []).push(result);
    try { result.imageIdBefore = await docker(['image', 'inspect', capabilityImage, '--format', '{{.Id}}'], 5000); }
    catch { result.imageIdBefore = null; }
    try {
      await execute('docker', ['--host', route === 'direct' ? host : proxyHost, 'run', '--rm', '--name', name, '--cidfile', cidFile,
        '--label', `cds.acceptance.owner=${source.owner}`, '--label', 'cds.managed=true', '--label', 'cds.type=agent-session',
        '--label', `cds.instance=${instanceId}`, '--label', 'cds.agent.probe=runtime-validation', '--label', `cds.agent.probe.operation=${operationId}`,
        '--pull', 'never', '--read-only', '--network', 'none', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
        '--pids-limit', '64', '--memory', '128m', '--cpus', '0.25', '--entrypoint', '/bin/sh', capabilityImage, '-lc', validationScript],
      { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
      result.exitCode = 0; result.originalRuntimeVersionAndSkillProbePassed = true;
    } catch (error) {
      result.exitCode = typeof (error as any).code === 'number' ? (error as any).code : null;
      result.interrupted = Boolean((error as any).killed); result.originalRuntimeVersionAndSkillProbePassed = false;
    }
    result.endedAt = new Date().toISOString(); result.elapsedMs = performance.now() - started;
    try {
      const descriptor = await fs.open(cidFile, 'r');
      try { const data = Buffer.alloc(129), read = await descriptor.read(data, 0, data.length, 0);
        const id = data.subarray(0, read.bytesRead).toString('utf8').trim();
        if (/^[a-f0-9]{64}$/.test(id)) result.containerId = id;
      } finally { await descriptor.close(); }
    } catch { /* No CID is unknown, not proof that a timed-out create was revoked. */ }
    try {
      const view = JSON.parse(await docker(['inspect', '--format', '{{json .}}', name], 5000));
      assert.match(view.Id, /^[a-f0-9]{64}$/); assert.equal(view.Name, '/' + name);
      assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner);
      assert.equal(view.Config.Labels['cds.instance'], instanceId); assert.equal(view.Config.Labels['cds.agent.probe.operation'], operationId);
      result.containerId = view.Id; result.stateBeforeDriverCleanup = view.State.Status;
      await docker(['rm', '-f', view.Id], 30_000); result.driverCleanupConfirmed = true;
    } catch { result.driverCleanupConfirmed = false; }
    await eventSnapshot(`protocol-comparison-${route}-after-original-recovery-failure`);
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
    await docker(['pull', capabilityImage], 600_000);
    probeProxy = await createProbeDaemonProxy(path.join(root, 'probe-daemon-proxy.sock'), '/var/run/owned.sock', cancelBoundary);
    report.cancellationBoundary = cancelBoundary;
    // Check the exact pinned image through the same socket used by the original
    // app before fault injection. This does not replace its own safety probe.
    const proxyHost = `unix://${path.join(root, 'probe-daemon-proxy.sock')}`;
    const directImageId = await docker(['image', 'inspect', capabilityImage, '--format', '{{.Id}}']);
    const proxyImageId = (await execute('docker', ['--host', proxyHost, 'image', 'inspect', capabilityImage, '--format', '{{.Id}}'],
      { encoding: 'utf8', timeout: 10_000 })).stdout.trim();
    assert.equal(proxyImageId, directImageId); assert.match(proxyImageId, /^sha256:[a-f0-9]{64}$/);
    const minimalEnv: NodeJS.ProcessEnv = { DOCKER_HOST: proxyHost };
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) minimalEnv[key] = process.env[key];
    const minimalImageId = (await execute('docker', ['image', 'inspect', capabilityImage, '--format', '{{.Id}}'],
      { encoding: 'utf8', timeout: 10_000, env: minimalEnv })).stdout.trim();
    assert.equal(minimalImageId, directImageId);
    report.proxyPinnedImagePreflight = { daemonId: info.ID, imageReference: capabilityImage, imageId: proxyImageId, matchedDirectBackend: true };
    let capabilityProjectId: string | undefined;
    await runApplicationBootstrap({ sourceHead: source.sourceHead, mongoUri: `mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, dockerHost: host, output: '/owned/output',
      dockerRequestProxy: { socketPath: path.join(root, 'probe-daemon-proxy.sock'), daemonId: info.ID, owner: source.owner },
      beforeShutdown: async context => {
        assert.ok(capabilityProjectId);
        // Original periodic reclaim remains enabled. Digest-only unused images
        // can be pruned during the earlier deployment exercise; establish the
        // required image again immediately before this bounded cancellation
        // fault, without replacing the app's own capability safety checks.
        await docker(['pull', capabilityImage], 600_000);
        const preparedImageId = (await execute('docker', ['--host', proxyHost, 'image', 'inspect', capabilityImage, '--format', '{{.Id}}'],
          { encoding: 'utf8', timeout: 10_000 })).stdout.trim();
        assert.equal(preparedImageId, directImageId);
        report.probeImageReadyAtFault = { at: new Date().toISOString(), imageId: preparedImageId, originalReclaimEnabled: true };
        probeProxy!.arm();
        let caught = false; void probeProxy!.caught.then(() => { caught = true; });
        report.capabilityProviderSnapshots = [];
        try {
          // The first read may observe the original startup recovery barrier;
          // keep reading the same public capability entry within the existing
          // 40-second bound, without forcing a refresh or bypassing that barrier.
          await until(async () => {
            const response = await context.request(`/api/projects/${capabilityProjectId}/agent-runtime-providers`);
            assert.equal(response.status, 200);
            const item = response.json.items.find((item: any) => item.id === 'open-design');
            assert.ok(item); assert.equal(item.healthy, false);
            report.capabilityProviderSnapshots.push({ at: new Date().toISOString(), healthy: item.healthy,
              resourcePolicyEnforcedPerSession: item.resourcePolicyEnforcedPerSession, verificationPending: item.verificationPending,
              reason: item.reason });
            return caught ? true : undefined;
          }, 40_000);
        } finally { report.probeEventsAtCreationBoundary = await context.readProbeEvents(); }
        report.probeApplicationPid = context.applicationPid(); assert.ok(report.probeApplicationPid);
        report.probeApplicationProcessTree = context.applicationProcessTree();
        report.probeFaultInjection = cancelBoundary === 'daemon-created'
          ? 'unchanged original create body forwarded to real owned daemon; original CLI create acknowledgement held until application cancellation after daemon 201'
          : 'unchanged original create body accepted by private Unix proxy; delayed forwarding to real owned daemon after original CLI disconnect';
      },
      afterFirstShutdown: async context => {
        await probeProxy!.settle(); report.probeRequestTimeline = probeProxy!.timeline;
        const request = probeProxy!.timeline.find(event => event.phase === 'original-create-received');
        const reply = probeProxy!.timeline.find(event => event.phase === 'backend-create-replied');
        assert.ok(request && reply); assert.equal(reply.status, 201); assert.match(reply.containerId, /^[a-f0-9]{64}$/);
        if (cancelBoundary === 'daemon-created') {
          const stopped = context.report.shutdownAttempts[0];
          const disconnected = probeProxy!.timeline.find(event => event.phase === 'original-client-disconnected');
          assert.ok(disconnected); assert.ok(reply.at <= stopped.requestedAt && stopped.requestedAt <= disconnected.at);
          assert.equal(stopped.code, 0); assert.ok(stopped.elapsedMs <= 15_000);
          assert.equal(probeProxy!.timeline.some(event => event.phase === 'forward-after-client-disconnect'), false);
        }
        for (const key of ['imageReference', 'cmdHash', 'entrypointHash', 'memoryBytes', 'nanoCpus', 'pidsLimit', 'readonlyRootfs', 'autoRemove', 'networkMode']) {
          assert.equal(request[key === 'imageReference' ? 'image' : key], (expectedCapabilityProbe as any)[key], key);
        }
        const rows = await auditNamespace('after-first-shutdown-before-restart'); assert.equal(rows.some(row => row.id === reply.containerId), false);
        const events = (await context.readProbeEvents()).filter(event => event.operationId === request.operationId);
        const assigned = events.find(event => event.action === 'agent.probe.execution.assigned');
        const acknowledged = events.find(event => event.action === 'agent.probe.creation.acknowledged');
        const cleaned = events.find(event => event.action === 'agent.probe.cleanup.confirmed');
        assert.ok(assigned && acknowledged && cleaned); assert.equal(acknowledged.details.containerId, reply.containerId);
        assert.equal(acknowledged.details.receipt, 'owned-inspect');
        assert.equal(cleaned.details.containerId, reply.containerId);
        assert.equal(assigned.details.executorAssignment.lane, 'operation');
        assert.ok(assigned.details.executorAssignment.factoryGeneration > 0 && assigned.details.executorAssignment.actorPid > 1);
        assert.ok(report.probeApplicationProcessTree.some((row: any) => row.pid === assigned.details.executorAssignment.actorPid));
        assert.ok(report.probeApplicationProcessTree.some((row: any) => row.pid === assigned.details.executorAssignment.factoryPid));
        const daemonEvents = await eventSnapshot('probe-cancel-confirmed-before-restart');
        for (const action of ['create', 'destroy']) assert.ok(daemonEvents.some(event => event.id === reply.containerId
          && event.action === action && event.probeOperationId === request.operationId && event.instanceId === request.instanceId));
        if (cancelBoundary === 'daemon-created') {
          const stopAt = Date.parse(context.report.shutdownAttempts[0].requestedAt);
          assert.ok(Date.parse(cleaned.at) - stopAt >= 0 && Date.parse(cleaned.at) - stopAt <= 10_000);
          const steps = events.filter(event => event.action === 'agent.probe.cleanup.step.requested'); assert.ok(steps.length);
          for (const event of steps) assert.ok(event.details.deadline - event.details.requestedAt > 0
            && event.details.deadline - event.details.requestedAt <= 5000);
          report.actualBudgetProbeCancellationVerified = true;
          context.report.actualBudgetProbeCancellationVerified = true;
        }
        report.probeCancellationEvents = events;
        report.checks.push({ name: cancelBoundary === 'daemon-created'
          ? 'original-on-demand-probe-cancel-after-daemon-create-before-CLI-ack-exact-ID-reconciled-before-restart'
          : 'original-on-demand-probe-cancel-late-real-create-exact-ID-reconciled-before-restart', passed: true });
      },
      afterRestart: async context => {
        await until(async () => { const response = await context.request(`/api/projects/${capabilityProjectId}/agent-runtime-providers`);
          assert.equal(response.status, 200); const item = response.json.items.find((item: any) => item.id === 'open-design');
          return item?.healthy && item.resourcePolicyEnforcedPerSession ? true : undefined; }, 90_000);
        const rows = await auditNamespace('after-real-normal-capability-validation');
        assert.equal(rows.some(row => row.matchesDefaultRuntimeValidation), false);
        report.normalCapabilityEvents = (await context.readProbeEvents()).filter(event => event.action === 'agent.probe.cleanup.confirmed');
        assert.ok(report.normalCapabilityEvents.some((event: any) => event.details.probeKind === 'storage-validation'));
        report.checks.push({ name: 'actual-pinned-runtime-CLI-skill-and-hard-storage-validation-remain-available-after-restart', passed: true });
      },
      afterFailedShutdown: async context => {
        // Retain the original failed normal-stop verdict. This additional phase
        // proves whether responsibility survives it; it cannot turn that stop green.
        const originalStop = context.report.shutdownAttempts?.[0];
        assert.equal(originalStop?.code, 1); assert.ok(originalStop.elapsedMs <= 15_000);
        const originalRequest = probeProxy!.timeline.find(event => event.phase === 'original-create-received');
        assert.ok(originalRequest);
        report.failureRecovery = { verdict: 'failed', originalStop, originalNormalStopPassed: false,
          operationId: originalRequest.operationId, instanceId: originalRequest.instanceId, restartRequestedAt: new Date().toISOString() };
        report.probeEventsAtFailedShutdown = await context.readProbeEvents();
        await context.restartForFailureRecovery();
        const recoveryTree = context.applicationProcessTree(); report.failureRecovery.processTree = recoveryTree;
        try { await until(async () => { const response = await context.request(`/api/projects/${capabilityProjectId}/agent-runtime-providers`);
          assert.equal(response.status, 200); const item = response.json.items.find((item: any) => item.id === 'open-design');
          return item?.healthy && item.resourcePolicyEnforcedPerSession ? true : undefined; }, 90_000); }
        catch (error) {
          // Run only after the original joint recovery failed; this driver-owned
          // comparison and its cleanup cannot satisfy any original application check.
          probeProxy!.enableTrace();
          await comparePinnedProbe('direct', proxyHost); await comparePinnedProbe('proxy', proxyHost);
          throw error;
        }
        await probeProxy!.settle();
        const reply = probeProxy!.timeline.find(event => event.phase === 'backend-create-replied');
        assert.equal(reply?.status, 201); assert.match(reply!.containerId, /^[a-f0-9]{64}$/);
        const rows = await auditNamespace('after-original-failed-stop-and-application-owned-recovery');
        assert.equal(rows.some(row => row.id === reply!.containerId || row.matchesDefaultRuntimeValidation), false);
        const allEvents = await context.readProbeEvents();
        const recovered = allEvents.filter(event => event.operationId === originalRequest.operationId);
        assert.ok(recovered.some(event => event.action === 'agent.probe.recovery.loaded'));
        assert.ok(recovered.some(event => event.action === 'agent.probe.cleanup.confirmed' && event.details.containerId === reply!.containerId));
        const loadedAt = recovered.findIndex(event => event.action === 'agent.probe.recovery.loaded');
        const removal = recovered.slice(loadedAt).find(event => event.action === 'agent.probe.cleanup.step.assigned' && event.details.cleanupStep === 'remove');
        assert.ok(removal?.details.cleanupExecutorAssignment);
        assert.ok(recoveryTree.some(row => row.pid === removal.details.cleanupExecutorAssignment.actorPid));
        assert.ok(recoveryTree.some(row => row.pid === removal.details.cleanupExecutorAssignment.factoryPid));
        const daemonEvents = await eventSnapshot('application-recovered-failed-probe-before-owned-harness-cleanup');
        for (const action of ['create', 'destroy']) assert.ok(daemonEvents.some(event => event.id === reply!.containerId
          && event.action === action && event.probeOperationId === originalRequest.operationId && event.instanceId === originalRequest.instanceId));
        assert.ok(allEvents.some(event => event.action === 'agent.probe.cleanup.confirmed' && event.details.probeKind === 'storage-validation'));
        report.failureRecovery.events = recovered; report.failureRecovery.normalCapabilityEvents = allEvents.filter(event => event.action === 'agent.probe.cleanup.confirmed');
        report.failureRecovery.shutdown = await context.stopForFailureRecovery(); // Original code0/15s, reused verbatim.
        report.failureRecovery.verdict = 'passed'; report.failureRecovery.finishedAt = new Date().toISOString();
        report.checks.push({ name: 'separate-failed-stop-owned-recovery-and-original-normal-capability-validation', passed: true,
          originalNormalStopPassed: false });
      },
      exercise: async (context: ApplicationBootstrapContext) => {
        const { request, requestRaw } = context;
        report.stage = 'real-project-create';
        const compose = 'services:\n' + ['api', 'web', 'worker'].map(role => `  ${role}:\n    image: "${registry}/owned-${role === 'web' ? 'web' : 'api'}:sha-\${CDS_COMMIT_SHA}"\n    ports: ["8080"]\n    environment:\n      SERVICE_NAME: "${role}"\n    labels:\n      cds.prebuilt-image: "true"\n      cds.subdomain: "${role}"\n      cds.readiness-path: "/"\n      cds.readiness-timeout: "30"\n`).join('');
        const created = await request('/api/projects', 'POST', { name: '完整应用隔离部署前提', slug: source.owner.replaceAll('_', '-'), composeYaml: compose,
          projectFiles: [{ relativePath: 'marker.txt', content: 'old-fixture' }] });
        assert.equal(created.status, 201, created.text); assert.equal(created.json.sandbox, true); const projectId = created.json.project.id; assert.ok(projectId); capabilityProjectId = projectId;
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
    if (probeProxy) {
      try { await probeProxy.settle(); report.probeRequestTimeline = probeProxy.timeline; report.proxyTraffic = probeProxy.traffic(); }
      catch (error) { cleanupErrors.push(String(error)); }
      await probeProxy.close();
      report.probeProxyRequestTimeline = probeProxy.requestTimeline; report.probeProxyTraceOverflow = probeProxy.traceOverflow();
    }
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
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main().catch(error => { console.error(error instanceof Error ? error.message : '原应用Docker部署前提演练失败'); process.exitCode = 1; });
