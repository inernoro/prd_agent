import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';

// 完整原 index 的隔离启动/鉴权前提；不以禁用 Docker 的预备路径代替 T09。
const option = (key: string) => { const n = process.argv.indexOf(key); return n < 0 ? '' : process.argv[n + 1] || ''; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort(): Promise<number> {
  const server = http.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) { const value = await read(); if (value !== undefined) return value;
    if (performance.now() >= deadline) throw new Error('私有完整启动探针到期'); await sleep(100); }
}
async function fileHashes(root: string, prefix = '', accept = /\.js$/): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await fileHashes(root, rel, accept));
    else if (entry.isFile() && accept.test(rel)) hashes[rel] = createHash('sha256').update(await fs.readFile(path.join(root, rel))).digest('hex');
  }
  return hashes;
}
function descendants(pid: number): Array<{ pid: number; ppid: number; rssKiB: number; stat: string }> {
  const rows = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,rss=,stat='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')
    .map(line => { const [p, parent, rss, stat] = line.trim().split(/\s+/); return { pid: Number(p), ppid: Number(parent), rssKiB: Number(rss), stat }; });
  const owned = new Set([pid]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
  return rows.filter(row => owned.has(row.pid));
}
export interface BootstrapRequestResult {
  status: number; json: any; cookie?: string; mime: string | null; elapsedMs: number; text: string;
}
export interface ApplicationBootstrapContext {
  root: string; repo: string; runtime: string; port: number; configFile: string;
  report: any;
  request: (endpoint: string, method?: string, body?: unknown, authenticated?: boolean) => Promise<BootstrapRequestResult>;
  requestRaw: (endpoint: string, body?: unknown, trigger?: 'manual' | 'webhook') => Promise<Response>;
  applicationPid: () => number | undefined;
  applicationProcessTree: () => ReturnType<typeof descendants>;
  readProbeEvents: () => Promise<any[]>;
  readDispatchEvents: (projectId: string, branchId: string) => Promise<any[]>;
  restartForFailureRecovery: () => Promise<void>;
  stopForFailureRecovery: () => Promise<{ code: number | null; signal: string | null }>;
}
export interface ApplicationBootstrapOptions {
  sourceHead?: string; mongoUri?: string; dockerHost?: string; output?: string;
  exercise?: (context: ApplicationBootstrapContext) => Promise<void>;
  beforeShutdown?: (context: ApplicationBootstrapContext) => Promise<void>;
  afterFirstShutdown?: (context: ApplicationBootstrapContext) => Promise<void>;
  afterRestart?: (context: ApplicationBootstrapContext) => Promise<void>;
  afterFailedShutdown?: (context: ApplicationBootstrapContext) => Promise<void>;
  dockerRequestProxy?: { socketPath: string; daemonId: string; owner: string };
}
export async function runApplicationBootstrap(options: ApplicationBootstrapOptions = {}): Promise<void> {
  const native = process.argv.includes('--native');
  if (native) { assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux'); assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/); }
  const owner = `cds_boot_${randomBytes(8).toString('hex')}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-application-ci-')); await fs.chmod(root, 0o700);
  const output = path.resolve(options.output || option('--output') || 'application-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const head = options.sourceHead || execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); assert.match(head, /^[0-9a-f]{40}$/);
  const compiledHashes = await fileHashes(path.resolve('dist'));
  const webHashes = await fileHashes(path.resolve('web/dist'), '', /./); assert.ok(webHashes['index.html']);
  const sourceHashes = await fileHashes(path.resolve('src'), '', /\.(?:ts|json)$/);
  const scriptHash = createHash('sha256').update(await fs.readFile('scripts/application-bootstrap-drill.ts')).digest('hex'); assert.ok(Object.keys(compiledHashes).length > 200);
  const report: any = { schema: 1, head, platform: os.platform(), native, startedAt: new Date().toISOString(), verdict: 'failed', checks: [],
    scope: options.dockerHost
      ? 'original compiled index startup with all default pools, private mongo-split/auth and owned Docker; application exercise pending; no whole first-stage/public/browser/performance acceptance'
      : 'original compiled index startup with all default execution pools, real private mongo-split and durable local-user bootstrap/login/restart; Docker endpoint deliberately unavailable; no whole first-stage deployment or public/browser/performance acceptance',
    sourceHashes, scriptHash, webHashes, sourceHeadOrigin: options.sourceHead ? 'outer-owner-verified-source-snapshot' : 'checkout-git', dockerAvailableFixture: Boolean(options.dockerHost),
    compiledHashes, actualFullIndexBootstrapVerified: false, actualAuthRestartVerified: false,
    actualWholeFirstStageVerified: false, browserVerified: false, publicPerformanceVerified: false, formalAcceptancePassed: false,
    ownedProcessesRemoved: false, ownedDatabaseRemoved: false, isolatedFilesRemoved: false };
  const env: NodeJS.ProcessEnv = {}; for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  let mongod: ChildProcess | undefined, application: ChildProcess | undefined, mongo: MongoClient | undefined;
  let captureProbeEvents: (() => Promise<any[]>) | undefined;
  let failureRecoveryContext: ApplicationBootstrapContext | undefined;
  const knownPids = new Set<number>(), appLogs: string[] = []; let exitApp: Promise<{ code: number | null; signal: string | null }> | undefined;
  const dbName = `${owner}_state`, authDb = `${owner}_auth`, password = randomBytes(24).toString('hex');
  const secretValues = [password];
  const scrub = (s: string) => secretValues.reduce((v, secret) => v.replaceAll(secret, '[private]'), s).slice(-65536);
  let uri = options.mongoUri || option('--mongo-uri');
  if (options.dockerHost) assert.equal(options.dockerHost, 'unix:///var/run/owned.sock');
  if (options.dockerRequestProxy) {
    assert.ok(options.dockerHost);
    assert.match(options.dockerRequestProxy.owner, /^cds_app_[a-f0-9]{16}$/);
    assert.equal(path.basename(options.dockerRequestProxy.socketPath), 'probe-daemon-proxy.sock');
    assert.equal((await fs.stat(options.dockerRequestProxy.socketPath)).isSocket(), true);
    assert.equal((await fs.stat(options.dockerRequestProxy.socketPath)).mode & 0o777, 0o600);
    const info = await new Promise<any>((resolve, reject) => {
      http.get({ socketPath: options.dockerRequestProxy!.socketPath, path: '/info' }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      }).on('error', reject);
    });
    assert.equal(info.ID, options.dockerRequestProxy.daemonId);
    report.dockerRequestProxy = { owner: options.dockerRequestProxy.owner, daemonId: info.ID, faultInjection: 'delay one original capability create until its client disconnects; forward unchanged to the owned daemon' };
  }
  try {
    report.stage = 'private-runtime-copy';
    const runtime = path.join(root, 'runtime'); await fs.mkdir(runtime);
    await fs.cp(path.resolve('dist'), path.join(runtime, 'dist'), { recursive: true });
    await fs.copyFile('package.json', path.join(runtime, 'package.json'));
    await fs.mkdir(path.join(runtime, 'web'));
    await fs.cp(path.resolve('web/dist'), path.join(runtime, 'web', 'dist'), { recursive: true });
    assert.deepEqual(await fileHashes(path.join(runtime, 'web/dist'), '', /./), webHashes);
    await fs.mkdir(path.join(runtime, 'src', 'services'), { recursive: true });
    await fs.copyFile('src/services/preview-demo-snapshot.json', path.join(runtime, 'src', 'services', 'preview-demo-snapshot.json'));
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(runtime, 'src', 'services', 'preview-demo-snapshot.json'))).digest('hex'), report.sourceHashes['services/preview-demo-snapshot.json']);
    await fs.symlink(path.resolve('node_modules'), path.join(runtime, 'node_modules'), 'dir');
    const copied = await fileHashes(path.join(runtime, 'dist')); assert.deepEqual(copied, compiledHashes);
    const repo = path.join(root, 'repo'); await fs.mkdir(repo);
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
    git(['init', '--quiet', '--initial-branch=private-main']); await fs.writeFile(path.join(repo, 'marker'), owner);
    git(['add', 'marker']); git(['-c', 'user.name=CDS隔离验收', '-c', 'user.email=owned@example.invalid', 'commit', '--quiet', '-m', '完整启动私有仓库']);
    report.fixtureGitHead = git(['rev-parse', 'HEAD']);
    if (!uri) {
      const port = await availablePort(), dbPath = path.join(root, 'mongo'); await fs.mkdir(dbPath);
      mongod = spawn('mongod', ['--bind_ip', '127.0.0.1', '--port', String(port), '--dbpath', dbPath, '--replSet', owner,
        '--logpath', path.join(root, 'mongo.log'), '--wiredTigerCacheSizeGB', '0.25'], { env, stdio: 'ignore' });
      const started = mongod; started.once('error', () => {}); assert.ok(started.pid); knownPids.add(started.pid);
      uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
      await waitFor(async () => { if (started.exitCode !== null) throw new Error('私有mongod提前退出');
        const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
        try { await probe.connect(); await probe.db('admin').command({ replSetInitiate: { _id: owner, members: [{ _id: 0, host: `127.0.0.1:${port}` }] } }); return true; }
        catch { return undefined; } finally { await probe.close(); } });
    }
    const parsed = new URL(uri); assert.equal(parsed.hostname, '127.0.0.1'); assert.ok(parsed.port);
    mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 }); await mongo.connect();
    await waitFor(async () => (await mongo!.db('admin').command({ hello: 1 })).isWritablePrimary ? true : undefined);
    assert.deepEqual(await mongo.db(dbName).listCollections().toArray(), []); assert.deepEqual(await mongo.db(authDb).listCollections().toArray(), []);
    report.privateDatabase = { freshState: true, freshAuth: true, ownedDaemon: Boolean(mongod), replicaSet: (await mongo.db('admin').command({ hello: 1 })).setName };
    const port = await availablePort(), workerPort = await availablePort(); assert.notEqual(port, workerPort);
    const envFile = path.join(root, '.cds.env'); await fs.writeFile(envFile, '');
    const configFile = path.join(root, 'cds.config.json');
    await fs.writeFile(configFile, JSON.stringify({ repoRoot: repo, worktreeBase: path.join(root, 'worktrees'), reposBase: path.join(root, 'repos'),
      masterPort: port, workerPort, executorPort: await availablePort(), dockerNetwork: owner, mode: 'standalone', rootDomains: [],
      sharedEnv: {}, scheduler: { enabled: false }, janitor: { enabled: false }, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'owned-bootstrap' } }));
    const appEnv = { ...env, CDS_ENV_FILE: envFile, CDS_MONGO_URI: uri, CDS_MONGO_DB: dbName, CDS_AUTH_MONGO_DB: authDb,
      CDS_AUTH_BACKEND: 'mongo', CDS_STORAGE_MODE: 'mongo-split', CDS_STATE_BOOTSTRAP_MODE: 'fresh', CDS_AUTH_MODE: 'github', CDS_GITHUB_CLIENT_ID: 'private-unused-oauth', CDS_GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
      CDS_USERNAME: 'private-legacy-disabled', CDS_PASSWORD: randomBytes(32).toString('hex'), CDS_SECRET_KEY: randomBytes(32).toString('hex'),
      CDS_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, CDS_UPTIME_ENABLED: '0', CDS_PREVIEW_AUTOWAKE: '0',
      DOCKER_HOST: options.dockerRequestProxy ? `unix://${options.dockerRequestProxy.socketPath}` : options.dockerHost || `unix://${root}/unavailable.sock` };
    secretValues.push(appEnv.CDS_PASSWORD, appEnv.CDS_SECRET_KEY, appEnv.CDS_GITHUB_CLIENT_SECRET);
    const start = () => {
      application = spawn(process.execPath, [path.join(runtime, 'dist', 'index.js'), configFile], { cwd: runtime, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.ok(application.pid); knownPids.add(application.pid); const current = application;
      current.once('error', () => {}); const log = (data: Buffer) => { appLogs.push(scrub(data.toString())); if (appLogs.join('').length > 131072) appLogs.shift(); };
      current.stdout!.on('data', log); current.stderr!.on('data', log);
      exitApp = new Promise(resolve => current.once('exit', (code, signal) => resolve({ code, signal })));
    };
    let cookie = '';
    const request = async (endpoint: string, method = 'GET', body?: unknown, authenticated = true) => {
      const began = performance.now(); const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method, headers: { 'Content-Type': 'application/json', ...(authenticated && cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const text = await response.text(); let json: any; try { json = JSON.parse(text); } catch { /* HTML is retained only by MIME assertions. */ }
      return { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0], mime: response.headers.get('content-type'), elapsedMs: performance.now() - began, text };
    };
    const requestRaw = (endpoint: string, body?: unknown, trigger: 'manual' | 'webhook' = 'manual') => fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CDS-Trigger': trigger },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(180_000),
    });
    const ready = async () => waitFor(async () => { if (application!.exitCode !== null) throw new Error('完整index在就绪前退出');
      try { const r = await request('/api/auth/bootstrap-status', 'GET', undefined, false); return r.status === 200 ? r : undefined; } catch { return undefined; } }, 45_000);
    const stop = async () => {
      assert.ok(application?.pid); for (const row of descendants(application.pid)) knownPids.add(row.pid);
      const began = performance.now(); const requestedAt = new Date().toISOString();
      application.kill('SIGTERM'); const ended = await Promise.race([exitApp!, sleep(15_000).then(() => { throw new Error('完整index正常停机未确认'); })]);
      (report.shutdownAttempts ??= []).push({ requestedAt, exitedAt: new Date().toISOString(), elapsedMs: performance.now() - began, ...ended });
      assert.equal(ended.code, 0); return ended;
    };
    const readProbeEvents = async () => (await mongo!.db(dbName).collection('cds_server_events').find({ source: { $in: ['agent-workspace-capability', 'core-image-cache'] } }).sort({ ts: -1 }).limit(512).toArray()).reverse()
      .map(event => ({ at: event.ts, source: event.source, action: event.action, operationId: event.operationId, containerName: event.containerName, details: event.details }));
    const readDispatchEvents = async (projectId: string, branchId: string) => {
      const events = await mongo!.db(dbName).collection('cds_server_events').find({ projectId, branchId,
        source: { $in: ['branch-operation-coordinator', 'auto-restart'] } }).sort({ ts: 1 }).limit(513).toArray();
      assert.ok(events.length <= 512, '派发证据超过固定上限，不截断后宣称完整');
      return events.map(event => ({ at: event.ts, source: event.source, action: event.action,
        projectId: event.projectId, branchId: event.branchId, profileId: event.profileId,
        operationId: event.operationId, operationKind: event.operationKind, operationTrigger: event.operationTrigger,
        operationActor: event.operationActor, operationSource: event.operationSource, commitSha: event.commitSha,
        details: Object.fromEntries(['operationId', 'generation', 'kind', 'trigger', 'actor', 'commitSha', 'source',
          'mergedCount', 'activeOperationId', 'activeKind', 'replayOf', 'continuedFromKind', 'continuedFromSource']
          .filter(key => Object.hasOwn(event.details || {}, key)).map(key => [key, event.details[key]])) }));
    };
    // 失败仍须先保存真实退出前的收尾回执；不得把外层销毁自有daemon当作应用清理成功。
    captureProbeEvents = readProbeEvents;
    const context: ApplicationBootstrapContext = { root, repo, runtime, port, configFile, report, request, requestRaw,
      applicationPid: () => application?.pid,
      applicationProcessTree: () => application?.pid ? descendants(application.pid) : [],
      readProbeEvents,
      readDispatchEvents,
      restartForFailureRecovery: async () => {
        assert.equal(application?.exitCode, 1); // A separate recovery after the original failed stop, never a replacement success assertion.
        start(); await ready();
        for (const row of descendants(application!.pid!)) knownPids.add(row.pid);
      },
      stopForFailureRecovery: stop,
    };
    failureRecoveryContext = context;
    report.stage = 'original-index-first-boot'; start(); const initial = await ready(); assert.equal(initial.json.needsBootstrap, true);
    const tree = descendants(application!.pid!); for (const row of tree) knownPids.add(row.pid);
    report.initialProcessTree = tree; report.initialTotalRssKiB = tree.reduce((sum, row) => sum + row.rssKiB, 0);
    // 六个原supervisor和工厂及24 actor来自原 index，未以小池替换配置。
    const supervisors = tree.filter(row => row.ppid === application!.pid); assert.equal(supervisors.length, 6);
    const factories = tree.filter(row => supervisors.some(s => s.pid === row.ppid)); assert.equal(factories.length, 6);
    const actors = tree.filter(row => factories.some(f => f.pid === row.ppid)); assert.equal(actors.length, 24);
    report.checks.push({ name: 'original-index-all-six-default-pools-and-24-actors', passed: true, supervisors: 6, factories: 6, actors: 24 });
    assert.equal((await request('/api/projects', 'GET', undefined, false)).status, 401);
    const boot = await request('/api/auth/bootstrap', 'POST', { username: 'private-owner', password, name: '隔离验收所有者' }, false);
    assert.equal(boot.status, 200); assert.ok(boot.json.user.id); assert.equal(boot.json.user.isSystemOwner, true); assert.ok(boot.cookie);
    cookie = boot.cookie; secretValues.push(cookie.split('=')[1]); const userId = boot.json.user.id;
    assert.equal((await request('/api/auth/bootstrap-status', 'GET', undefined, false)).json.needsBootstrap, false);
    const duplicate = await request('/api/auth/bootstrap', 'POST', { username: 'second-owner', password }, false); assert.equal(duplicate.status, 409);
    const html = await request('/project-list'); assert.equal(html.status, 200); assert.match(html.mime || '', /text\/html/);
    const assets = [...html.text.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(match => match[1]);
    assert.ok(assets.some(a => a.endsWith('.js')) && assets.some(a => a.endsWith('.css')));
    report.assetChecks = []; for (const asset of assets) { const got = await request(asset); assert.equal(got.status, 200);
      assert.match(got.mime || '', asset.endsWith('.css') ? /text\/css/ : /(?:application|text)\/(?:javascript|ecmascript)/);
      assert.equal(createHash('sha256').update(got.text).digest('hex'), webHashes[asset.slice(1)]);
      report.assetChecks.push({ path: asset, status: got.status, mime: got.mime, hashMatched: true }); }
    report.checks.push({ name: 'real-web-html-and-emitted-js-css-bytes-through-original-auth-server', passed: true });
    const projects = await request('/api/projects'); assert.equal(projects.status, 200); assert.ok(projects.json);
    report.checks.push({ name: 'real-durable-bootstrap-cookie-and-unauthorized-gate', passed: true, duplicateStatus: duplicate.status, userId });
    report.actualFullIndexBootstrapVerified = true;
    if (options.exercise) {
      report.scope = 'original compiled full index/auth/server with all default pools and owned Docker application exercise; generic fixture only, no representative business CI/public/browser/performance acceptance';
      report.stage = 'owned-docker-application-exercise';
      await options.exercise(context);
    }
    if (options.beforeShutdown) await options.beforeShutdown(context);
    report.stage = 'graceful-shutdown-restart'; report.firstShutdown = await stop();
    if (options.afterFirstShutdown) await options.afterFirstShutdown(context);
    start();
    const restarted = await ready(); assert.equal(restarted.json.needsBootstrap, false);
    assert.equal((await request('/api/projects')).status, 200); // 原 cookie，而非重铸会话。
    assert.equal((await request('/api/projects', 'GET', undefined, false)).status, 401);
    const wrong = await request('/api/auth/login', 'POST', { username: 'private-owner', password: 'wrong-private-password' }, false); assert.equal(wrong.status, 401);
    const login = await request('/api/auth/login', 'POST', { username: 'private-owner', password }, false); assert.equal(login.status, 200); assert.equal(login.json.user.id, userId);
    report.actualAuthRestartVerified = true; report.checks.push({ name: 'original-index-restart-retains-owner-and-original-session', passed: true });
    if (options.afterRestart) await options.afterRestart(context);
    report.finalShutdown = await stop(); application = undefined; report.verdict = 'passed';
  } catch (error) {
    report.failure = { stage: report.stage, message: scrub(error instanceof Error ? error.message : String(error)) };
    if (report.stage === 'graceful-shutdown-restart' && application?.exitCode === 1 && options.afterFailedShutdown && failureRecoveryContext) {
      try {
        report.probeEventsAtFailedShutdown = await failureRecoveryContext.readProbeEvents();
        await options.afterFailedShutdown(failureRecoveryContext);
        report.failureRecoveryVerified = true;
      } catch (recoveryError) { report.failureRecoveryVerified = false;
        report.failureRecoveryFailure = scrub(recoveryError instanceof Error ? recoveryError.message : String(recoveryError)); }
    }
    throw error; // The original failed verdict, code-0 assertion and budgets remain authoritative.
  }
  finally {
    if (application?.pid && application.exitCode === null) { for (const row of descendants(application.pid)) knownPids.add(row.pid);
      application.kill('SIGTERM'); await Promise.race([exitApp!, sleep(15_000)]); if (application.exitCode === null) application.kill('SIGKILL'); }
    // 仅自有临时进程ID；私有工厂是detached，不用广播killall。
    for (const pid of knownPids) {
      if (pid === mongod?.pid) continue;
      try {
        const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim();
        if (command.includes(root + path.sep)) process.kill(pid, 'SIGKILL');
      } catch { /* 已退出或身份不符，绝不杀其他进程。 */ }
    }
    if (mongo) {
      try { if (captureProbeEvents) { report.probeEventsBeforeOwnedDatabaseRemoval = await captureProbeEvents(); report.probeEventsCapturedAt = new Date().toISOString(); } }
      catch { report.probeEventCaptureFailed = true; }
      await mongo.db(dbName).dropDatabase(); await mongo.db(authDb).dropDatabase();
      assert.deepEqual(await mongo.db(dbName).listCollections().toArray(), []); assert.deepEqual(await mongo.db(authDb).listCollections().toArray(), []); await mongo.close(); report.ownedDatabaseRemoved = true; }
    if (mongod?.pid && mongod.exitCode === null) { mongod.kill('SIGTERM'); await waitFor(async () => mongod!.exitCode !== null ? true : undefined, 10_000); }
    await sleep(100); report.remainingPids = [...knownPids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    report.ownedProcessesRemoved = report.remainingPids.length === 0;
    await fs.writeFile(path.join(output, 'application.log'), scrub(appLogs.join('')));
    await fs.rm(root, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.ownedProcessesRemoved, true); assert.equal(report.ownedDatabaseRemoved, true);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runApplicationBootstrap().catch(error => { console.error(error instanceof Error ? error.message : '完整启动演练失败'); process.exitCode = 1; });
}
