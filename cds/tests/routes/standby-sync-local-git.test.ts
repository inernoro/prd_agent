import { resolveBranchEnvLayers } from '../../src/services/branch-env-layers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { createProjectMigrationRouter } from '../../src/routes/project-migration.js';
import { buildStandbyBranchConfiguration } from '../../src/services/standby-mirror.js';
import type { BranchEntry, CdsConfig, ExecOptions, IShellExecutor } from '../../src/types.js';

let root: string, origin: string, author: string, repo: string, shaA: string;
let source: StateService, target: StateService, targetUrl: string, sourceUrl: string;
let servers: http.Server[], commands: string[], writes: string[];
let beforeCreate: (() => void) | undefined;
let createdReply: ((body: any) => any) | undefined;
let targetFingerprintReply: ((body: any) => any) | undefined;
let deployOutcome: 'success' | 'error' | 'long-error' | 'false' | 'missing';
let deployedCommits: string[];
let useRealRuntimeGuard: boolean;
let worktree: WorktreeService;
let afterDeploy: (() => void) | undefined;
let scheduledTick: () => void;
let auditFile: string;
let scheduledInterval: ReturnType<typeof setInterval>;
let fingerprintOverride: { status: number; body: string; type?: string; headers?: Record<string, string>; delayMs?: number; headersOnly?: boolean } | undefined;
let responseTimers: ReturnType<typeof setTimeout>[];
const auditSink = {
  record: () => { throw new Error('Durable audit must use immediate writes'); },
  recordImmediate: async (record: any) => fs.appendFileSync(auditFile, JSON.stringify(record) + '\n'),
  findRecent: async (filter: any = {}) => fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(record => (!filter.projectId || record.projectId === filter.projectId) && (!filter.requestId || record.requestId === filter.requestId)).reverse()
    : [],
};
const projectId = 'fixture';
const targetConfiguration = (entry: BranchEntry) => buildStandbyBranchConfiguration({ branch: entry, profiles: target.getBuildProfilesForProject(projectId),
  env: target.getCustomEnv(projectId), branchEnv: target.getCustomEnvScope(entry.id), infra: target.getInfraServicesForProject(projectId),
  routingRules: target.getRoutingRulesForProject(projectId) });
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function seed(state: StateService, branch: string, sha: string | undefined, status = 'running'): BranchEntry {
  const entry = { id: `fixture-${branch.replaceAll('/', '-')}`, projectId, branch, status,
    githubCommitSha: sha, services: status === 'running' && sha ? { api: { profileId: 'api', status: 'running', sourceCommitSha: sha,
      containerName: 'mock-runtime', containerId: 'mock-only', hostPort: 17001 } } : {},
    worktreePath: path.join(root, 'unused', branch), createdAt: new Date().toISOString() } as BranchEntry;
  state.addBranch(entry);
  return entry;
}
async function listen(app: express.Express): Promise<string> {
  // 共用 setup fixture 将无 host 的临时 listener 固定为 127.0.0.1。
  const server = await new Promise<http.Server>((resolve, reject) => { const s = app.listen(0, () => resolve(s)); s.once('error', reject); });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function appWithOwner(): express.Express {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).cdsUser = { username: 'fixture-owner', isSystemOwner: true, authProvider: 'local' };
    (req as any).cdsSession = { id: 'fixture-session' }; next();
  });
  return app;
}
async function reconcile(policy = 'catalog', extra: Record<string, unknown> = {}) {
  const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/reconcile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: 'fixture-peer', remoteProjectId: projectId, policy, dryRun: false, ...extra }),
  });
  return { status: response.status, body: await response.json() as any };
}
function advanceOrigin(): string {
  fs.writeFileSync(path.join(author, 'fixture.txt'), 'B\n'); git(author, 'add', '.');
  git(author, 'commit', '-m', 'fixture B'); git(author, 'push', 'origin', 'main');
  return git(author, 'rev-parse', 'HEAD');
}
beforeEach(async () => {
  vi.stubEnv('CDS_AI_ACCESS_KEY', ''); vi.stubEnv('AI_ACCESS_KEY', '');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-standby-local-'));
  auditFile = path.join(root, 'response-audit.jsonl');
  fingerprintOverride = undefined;
  responseTimers = [];
  servers = []; commands = []; writes = []; beforeCreate = undefined; createdReply = undefined; targetFingerprintReply = undefined;
  deployOutcome = 'success'; deployedCommits = []; useRealRuntimeGuard = false;
  afterDeploy = undefined;
  origin = path.join(root, 'origin.git'); author = path.join(root, 'author'); repo = path.join(root, 'target');
  fs.mkdirSync(author); git(author, 'init', '-b', 'main'); git(author, 'config', 'user.name', 'Fixture');
  git(author, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(author, 'fixture.txt'), 'A\n'); git(author, 'add', '.'); git(author, 'commit', '-m', 'fixture A');
  git(root, 'clone', '--bare', author, origin); git(author, 'remote', 'add', 'origin', pathToFileURL(origin).href);
  git(root, 'clone', pathToFileURL(origin).href, repo); shaA = git(author, 'rev-parse', 'HEAD');
  source = new StateService(path.join(root, 'source-state.json')); source.load();
  target = new StateService(path.join(root, 'target-state.json')); target.load();
  for (const state of [source, target]) state.addProject({ id: projectId, slug: projectId, name: 'Synthetic only', kind: 'git',
    githubRepoFullName: 'fixture/standby', gitDefaultBranch: 'main', repoPath: repo, cloneStatus: 'ready',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const realShell = new ShellExecutor();
  const shell: IShellExecutor = { exec: async (command: string, options?: ExecOptions) => {
    if (!/^(git |mkdir -p |test -d |rm -rf )/.test(command) || /https?:|ssh:|docker|curl/.test(command)) throw new Error('Non-local command refused');
    if (options?.cwd && !options.cwd.startsWith(root + '/')) throw new Error('Non-fixture cwd refused');
    commands.push(command); return realShell.exec(command, options);
  } };
  worktree = new WorktreeService(shell);
  const targetApp = appWithOwner();
  targetApp.get('/healthz', (_req, res) => res.json({ ok: true }));
  targetApp.use((req, res, next) => {
    if (req.method !== 'GET') writes.push(req.path);
    if (req.path.endsWith('/migration/fingerprint') && fingerprintOverride) {
      const override = fingerprintOverride;
      if (override.headers) res.set(override.headers);
      if (override.headersOnly) { res.status(override.status).type(override.type || 'application/json').flushHeaders(); return; }
      const send = () => res.status(override.status).type(override.type || 'application/json').send(override.body);
      if (override.delayMs) { const timer = setTimeout(send, override.delayMs); timer.unref(); responseTimers.push(timer); } else send();
      return;
    }
    if (req.path.endsWith('/migration/fingerprint') && targetFingerprintReply) {
      const send = res.json.bind(res); res.json = ((body: any) => send(targetFingerprintReply!(body))) as typeof res.json;
    }
    if (req.path === '/api/branches' && req.method === 'POST') {
      beforeCreate?.();
      if (createdReply) { const send = res.json.bind(res); res.json = ((body: any) => send(createdReply!(body))) as typeof res.json; }
    }
    next();
  });
  // Only these controlled handlers simulate runtime actions. No ContainerService or Docker is used.
  targetApp.post('/api/branches/:id/deploy', (req, res, next) => {
    if (useRealRuntimeGuard) { next(); return; }
    deployedCommits.push(req.body.commitSha);
    if (deployOutcome === 'success') {
      const branch = target.getBranch(req.params.id)!; branch.status = 'running';
      branch.services.api = { profileId: 'api', status: 'running', sourceCommitSha: req.body.commitSha,
        containerName: 'mock-runtime', containerId: 'mock-only', hostPort: 17001 } as any;
      afterDeploy?.();
    }
    res.type('text/event-stream').send(deployOutcome === 'success' ? 'event: complete\ndata: {"ok":true}\n\n'
      : deployOutcome === 'long-error' ? `${'event: progress\ndata: {"message":"PRIVATE_PROGRESS_SENTINEL"}\n\n'.repeat(180)}event: error\ndata: {"message":"late terminal failure","code":"PEER_DEPLOY_FAILED"}\n\n`
      : deployOutcome === 'error' ? 'event: error\ndata: {"message":"fixture failure"}\n\n'
      : deployOutcome === 'false' ? 'event: complete\ndata: {"ok":false}\n\n' : 'event: progress\ndata: {"ok":true}\n\n');
  });
  targetApp.post('/api/branches/:id/stop', (req, res, next) => { if (useRealRuntimeGuard) { next(); return; } target.getBranch(req.params.id)!.status = 'idle'; res.json({ ok: true }); });
  targetApp.use('/api', createProjectMigrationRouter({ stateService: target, authMode: 'basic', assertProjectAccess: () => null }));
  targetApp.use('/api', createBranchRouter({ stateService: target, worktreeService: worktree, shell,
    containerService: {} as any, config: { repoRoot: repo, worktreeBase: path.join(root, 'worktrees'), dockerNetwork: 'never-used',
      masterPort: 9900, portStart: 17000, sharedEnv: {} } as CdsConfig }));
  targetUrl = await listen(targetApp);
  source.addCdsPeer({ id: 'fixture-peer', name: 'loopback only', baseUrl: targetUrl, createdAt: new Date().toISOString() });
  const sourceApp = appWithOwner();
  const originalInterval = global.setInterval;
  const intervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((callback: () => void, ms: number, ...args: any[]) => {
    if (ms === 60_000) scheduledTick = callback;
    const handle = originalInterval(callback, ms, ...args);
    if (ms === 60_000) scheduledInterval = handle;
    return handle;
  }) as typeof setInterval);
  try {
    sourceApp.use('/api', createProjectMigrationRouter({ stateService: source, authMode: 'basic', assertProjectAccess: () => null,
      serverEventLogStore: auditSink } as any));
  } finally { intervalSpy.mockRestore(); }
  sourceUrl = await listen(sourceApp);
});
afterEach(async () => {
  clearInterval(scheduledInterval);
  responseTimers.forEach(clearTimeout);
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all([source.flush(), target.flush()]);
  fs.rmSync(root, { recursive: true, force: true }); expect(fs.existsSync(root)).toBe(false);
  expect(servers.every(server => !server.listening)).toBe(true); vi.unstubAllEnvs();
});

describe('three-policy real local Git / HTTP / State / fingerprint chain', () => {
  it.each(['branch-env', 'override-env', 'extra-env', 'active-mode-env'])('effective %s database settings cannot be declared stateless', async layer => {
    for (const state of [source, target]) {
      const branch = seed(state, 'main', shaA);
      const profile: any = { id: 'api', projectId, name: 'API', dockerImage: 'node', command: 'node app.js', containerPort: 8080, env: {} };
      if (layer === 'branch-env') state.setCustomEnv({ MONGODB_URL: 'mongodb://synthetic.invalid/data' }, branch.id);
      if (layer === 'override-env') branch.profileOverrides = { api: { env: { MONGODB_URL: 'mongodb://synthetic.invalid/data' } } };
      if (layer === 'extra-env') branch.extraProfiles = [{ ...profile, id: 'extra', env: { MONGODB_URL: 'mongodb://synthetic.invalid/data' } }];
      if (layer === 'active-mode-env') { profile.activeDeployMode = 'special'; profile.deployModes = { special: { env: { MONGODB_URL: 'mongodb://synthetic.invalid/data' }, command: 'node app.js' } }; }
      state.addBuildProfile(profile);
    }
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'fixture-peer', remoteProjectId: projectId }) });
    const { audit } = await response.json() as any;
    expect(audit.currentDataVerified).toBe(false); expect(audit.readyForFailover).toBe(false);
  });
  it('saving unchanged standby settings preserves its semantic revision', async () => {
    const config = { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true, branchSyncPolicy: 'catalog' as const,
      autoFailover: false as const, intervalMinutes: 5, updatedAt: '2026-10-01T00:00:00Z' };
    source.updateProject(projectId, { standbyMirror: config });
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    expect(response.status).toBe(200); expect((await response.json() as any).config.updatedAt).toBe(config.updatedAt);
  });
  it('changing a standby target preserves prior audit history while invalidating current target results', async () => {
    const history = [{ id: 'synthetic-prior-audit', peerId: 'fixture-peer', remoteProjectId: projectId }] as any;
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'catalog', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-01', history, lastAudit: history[0] } });
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'fixture-peer', remoteProjectId: 'different-target', enabled: true, branchSyncPolicy: 'catalog', intervalMinutes: 5 }) });
    const { config } = await response.json() as any;
    expect(config.history).toEqual(history); expect(config.lastAudit).toBeUndefined(); expect(config.updatedAt).not.toBe('2026-10-01');
  });
  it.each(['source', 'target'])('effective %s configuration changes after fingerprint response prevent deployment', async side => {
    for (const state of [source, target]) state.addBuildProfile({ id: 'api', projectId, name: 'API', dockerImage: 'node', command: 'node original.js', containerPort: 8080 } as any);
    const local = seed(source, 'main', shaA), remote = seed(target, 'main', shaA, 'idle'); useRealRuntimeGuard = side === 'target';
    let reads = 0; targetFingerprintReply = body => { if (++reads === 2) (side === 'source' ? local : remote).profileOverrides = { api: { command: 'node changed.js' } }; return body; };
    const response = await reconcile('warm-running'); expect(response.status).toBe(207);
    expect(response.body.result.deployed).toEqual([]); expect(remote.status).toBe('idle'); expect(commands).toEqual([]);
    if (side === 'source') expect(writes).toEqual([]);
  });
  it.each(['source', 'target'])('a %s config change during an accepted deployment is not reported as converged', async side => {
    for (const state of [source, target]) state.addBuildProfile({ id: 'api', projectId, name: 'API', dockerImage: 'node', command: 'node original.js', containerPort: 8080 } as any);
    const local = seed(source, 'main', shaA), remote = seed(target, 'main', shaA, 'idle');
    afterDeploy = () => { (side === 'source' ? local : remote).profileOverrides = { api: { env: { PUBLIC_SETTING: 'new' } } }; };
    const response = await reconcile('warm-running'); expect(response.status).toBe(207);
    expect(response.body.result.deployed).toEqual([]); expect(deployedCommits).toEqual([shaA]);
    expect((side === 'source' ? local : remote).profileOverrides?.api.env?.PUBLIC_SETTING).toBe('new');
  });
  it.each(['command', 'override-env', 'extra', 'mode', 'branch-env', 'db-scope'])('warm-running refuses non-default effective %s configuration divergence', async layer => {
    for (const state of [source, target]) {
      seed(state, 'main', shaA);
      state.addBuildProfile({ id: 'api', projectId, name: 'API', dockerImage: 'node', command: 'node original.js', containerPort: 8080, env: {},
        deployModes: { original: { command: 'node original.js', env: { PUBLIC_SETTING: 'original' } }, different: { command: 'node different.js', env: { PUBLIC_SETTING: 'different' } } } } as any);
    }
    const branch = seed(source, 'feature', shaA); const remote = seed(target, 'feature', shaA, 'idle');
    if (layer === 'command') branch.profileOverrides = { api: { command: 'node different.js' } };
    if (layer === 'override-env') branch.profileOverrides = { api: { env: { PUBLIC_SETTING: 'different' } } };
    if (layer === 'extra') branch.extraProfiles = [{ id: 'extra', projectId, name: 'Extra', dockerImage: 'node', containerPort: 8081, command: 'node extra.js' } as any];
    if (layer === 'db-scope') {
      branch.profileOverrides = { api: { dbScope: 'per-branch' } };
      for (const state of [source, target]) state.getBuildProfilesForProject(projectId)[0].env = { MONGODB_URL: 'mongodb://synthetic.invalid/app' };
      const sourceEnv = resolveBranchEnvLayers(source, branch, { jwtIssuer: 'cds' }).profiles[0].provenance;
      const targetEnv = resolveBranchEnvLayers(target, remote, { jwtIssuer: 'cds' }).profiles[0].provenance;
      expect(sourceEnv.find(row => row.key === 'MONGODB_URL')?.value).toBe('mongodb://synthetic.invalid/app_feature');
      expect(targetEnv.find(row => row.key === 'MONGODB_URL')?.value).toBe('mongodb://synthetic.invalid/app');
    }
    if (layer === 'mode') branch.profileOverrides = { api: { activeDeployMode: 'different' } };
    if (layer === 'branch-env') source.setCustomEnv({ PUBLIC_SETTING: 'different' }, branch.id);
    const response = await reconcile('warm-running');
    expect(response.status).toBe(207); expect(response.body.result.deployed).toEqual([]);
    expect(response.body.result.failed.some((failure: any) => failure.name === 'feature')).toBe(true);
    expect(remote.status).toBe('idle'); expect(writes).toEqual([]);
  });
  it('resolves the fallback CDS branch id to its Git branch name', async () => {
    const branch = seed(source, 'main', shaA);
    source.updateProject(projectId, { gitDefaultBranch: undefined, defaultBranch: branch.id });
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/fingerprint`);
    expect((await response.json() as any).defaultBranch).toBe('main');
  });
  it('malformed successful fingerprints produce a persisted failed audit rather than retaining old readiness', async () => {
    seed(source, 'main', shaA); fingerprintOverride = { status: 200, body: JSON.stringify({ protocolVersion: 1 }) };
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'audit-only', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-01' } });
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).not.toBe(500);
    const audit = source.getProject(projectId)!.standbyMirror!.lastAudit!;
    expect(audit.readyForFailover).toBe(false); expect(audit.error).toContain('指纹');
    expect((await auditSink.findRecent({ projectId })).some(row => row.details?.localDecision === 'parse-failure')).toBe(true);
  });
  it('health cannot pass when the complete takeover gate rejects an otherwise reachable standby', async () => {
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'audit-only', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-01',
      lastAudit: { checkedAt: new Date().toISOString(), remoteReachable: true, protocolReady: true, defaultBranchMatches: true, readyForFailover: false } as any } });
    expect((await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby-health`)).status).toBe(503);
  });
  it('a fresh complete stateless gate still passes health after an audited normal round', async () => {
    seed(source, 'main', shaA); seed(target, 'main', shaA);
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'audit-only', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-01' } });
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await response.json() as any).audit.readyForFailover).toBe(true);
    expect((await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby-health`)).status).toBe(200);
  });
  it('an enabled standby peer cannot be deleted underneath its scheduled policy', async () => {
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'catalog', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-01' } });
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/peers/fixture-peer`, { method: 'DELETE' });
    expect(response.status).toBe(409); expect(source.getCdsPeer('fixture-peer')).toBeDefined();
  });
  it('a previously missing peer records failed freshness evidence without changing the enabled policy', async () => {
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'catalog', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-01' } });
    source.removeCdsPeer('fixture-peer'); scheduledTick();
    const config = source.getProject(projectId)!.standbyMirror!;
    expect(config.enabled).toBe(true); expect(config.lastAudit?.readyForFailover).toBe(false);
    expect(config.lastAudit?.error).toContain('不存在'); expect(writes).toEqual([]);
  });
  it.each(['stateless', 'app-persistent', 'external-db', 'reverse', 'other-project', 'subset', 'stale', 'exact'])('data readiness uses scoped current evidence: %s', async scenario => {
    const branch = seed(source, 'main', shaA); branch.createdAt = '2026-10-01T00:00:00Z';
    source.updateProject(projectId, { createdAt: '2026-10-01T00:00:00Z', standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'audit-only', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-02T00:00:00Z' } });
    const infra = ['stateless', 'app-persistent', 'external-db'].includes(scenario) ? [] : [{ id: 'mongo', projectId, name: 'Mongo', dockerImage: 'mongo:7', containerPort: 27017, dbName: 'fixture-db', env: {}, volumes: [] }];
    const infraSpy = vi.spyOn(source, 'getInfraServicesForProject').mockReturnValue(infra as any);
    const profiles = vi.spyOn(source, 'getBuildProfilesForProject').mockReturnValue(['app-persistent', 'external-db'].includes(scenario) ? [{ id: 'app', name: 'App', dockerImage: 'node', containerPort: 8080,
      ...(scenario === 'external-db' ? { env: { MONGODB_URI: 'mongodb://synthetic.invalid/data' } } : { cacheMounts: [{ kind: 'volume', hostPath: 'app-data', containerPath: '/data', storage: {
        version: 1, purpose: 'persistent', instanceId: 'fixture-instance', projectId, scope: 'branch-private', branchId: branch.id, serviceId: 'app', mountKey: 'data' } }] }) }] as any : []);
    const migration = { id: 'fixture-migration', projectId, dbType: 'mongodb', status: 'completed', progress: 100,
      source: { type: 'local', projectId, serviceId: 'mongo', database: 'fixture-db' },
      target: { type: 'cds', cdsPeerId: 'fixture-peer', projectId: scenario === 'other-project' ? 'another-project' : projectId, serviceId: 'mongo', database: 'fixture-db' },
      startedAt: '2026-10-03T00:00:00Z', finishedAt: scenario === 'stale' ? '2026-10-01T00:00:00Z' : '2026-10-04T00:00:00Z',
      ...(scenario === 'subset' ? { collections: ['only-one'] } : {}) } as any;
    if (scenario === 'reverse') [migration.source, migration.target] = [migration.target, migration.source];
    const migrationSpy = vi.spyOn(source, 'getDataMigrations').mockReturnValue(scenario === 'stateless' ? [] : [migration]);
    try {
      const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(200);
      expect((await response.json() as any).audit.dataSnapshotReady).toBe(['stateless', 'exact'].includes(scenario));
    } finally { infraSpy.mockRestore(); migrationSpy.mockRestore(); profiles.mockRestore(); }
  });
  it('a historical matching migration does not prove current stateful takeover safety', async () => {
    for (const state of [source, target]) { const branch = seed(state, 'main', shaA); branch.createdAt = '2026-10-01T00:00:00Z'; }
    source.updateProject(projectId, { createdAt: '2026-10-01T00:00:00Z', standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'audit-only', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-02T00:00:00Z' } });
    const infra = [{ id: 'mongo', projectId, name: 'Mongo', dockerImage: 'mongo:7', containerPort: 27017, dbName: 'fixture-db', env: {}, volumes: [] }] as any;
    const sourceInfra = vi.spyOn(source, 'getInfraServicesForProject').mockReturnValue(infra);
    const targetInfra = vi.spyOn(target, 'getInfraServicesForProject').mockReturnValue(infra);
    const migration = vi.spyOn(source, 'getDataMigrations').mockReturnValue([{ id: 'historical', projectId, status: 'completed',
      source: { type: 'local', projectId, serviceId: 'mongo' }, target: { type: 'cds', projectId, cdsPeerId: 'fixture-peer', serviceId: 'mongo' },
      startedAt: '2026-10-03T00:00:00Z', finishedAt: '2026-10-04T00:00:00Z' } as any]);
    try {
      const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const { audit } = await response.json() as any;
      expect(audit.defaultBranchMatches).toBe(true); expect(audit.configMatches).toBe(true); expect(audit.dataSnapshotReady).toBe(true);
      expect(audit.readyForFailover).toBe(false);
      expect(audit.currentDataVerified).toBe(false); expect(audit.dataReadinessReason).toContain('历史快照');
      expect((await reconcile('warm-running')).status).toBe(200);
      source.getAllBranches()[0].lastPushAt = new Date().toISOString();
      const saved = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...source.getProject(projectId)!.standbyMirror }) }); expect(saved.status).toBe(200);
      const checked = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const refreshed = (await checked.json() as any).audit;
      expect(refreshed.dataSnapshotReady).toBe(true); expect(refreshed.currentDataVerified).toBe(false); expect(refreshed.readyForFailover).toBe(false);
    } finally { sourceInfra.mockRestore(); targetInfra.mockRestore(); migration.mockRestore(); }
  });
  it.each(['disabled', 'audit-only', 'peer', 'project', 'peer-url', 'peer-key', 'fallback-key'])('scheduled sync refuses stale %s settings after audit awaits', async mutation => {
    seed(source, 'main', shaA);
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'catalog', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-28T00:00:00Z' } });
    let changed = false;
    targetFingerprintReply = body => {
      if (!changed) {
        changed = true;
        const config = source.getProject(projectId)!.standbyMirror!;
        if (mutation === 'peer-url') source.getCdsPeer('fixture-peer')!.baseUrl += '/changed-target';
        else if (mutation === 'peer-key') source.getCdsPeer('fixture-peer')!.accessKey = 'synthetic-changed-key';
        else if (mutation === 'fallback-key') vi.stubEnv('AI_ACCESS_KEY', 'synthetic-changed-fallback');
        else source.updateProject(projectId, { standbyMirror: { ...config,
          ...(mutation === 'disabled' ? { enabled: false } : mutation === 'audit-only' ? { branchSyncPolicy: 'audit-only' as const }
            : mutation === 'peer' ? { peerId: 'new-peer' } : { remoteProjectId: 'new-project' }) } });
      }
      return body;
    };
    scheduledTick();
    await vi.waitFor(() => expect(changed).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(writes).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('scheduled catalog with unchanged settings still creates the missing branch', async () => {
    seed(source, 'main', shaA);
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'catalog', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-28T00:00:00Z' } });
    scheduledTick();
    await vi.waitFor(() => expect(source.getProject(projectId)!.standbyMirror?.lastBranchSync?.created).toEqual(['main']));
    expect(target.getAllBranches()).toHaveLength(1);
  });
  it('persists and cold-queries bounded response evidence before reporting sync success', async () => {
    seed(source, 'main', shaA);
    const result = await reconcile(); expect(result.status).toBe(200);
    const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/response-evidence?operationId=${result.body.result.responseAuditId}`);
    expect(response.status).toBe(200);
    const { records } = await response.json() as any;
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.every(record => record.projectId === projectId && record.requestId && record.operationId)).toBe(true);
    expect(records.some(record => record.details?.httpStatus === 201 && record.details?.responseReceived === true)).toBe(true);
    expect(new Set(records.map(record => record.operationId)).size).toBe(1);
  });
  it('scheduled writes recheck settings after reconciliation fingerprint awaits', async () => {
    seed(source, 'main', shaA); let fingerprints = 0;
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'catalog', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-28T00:00:00Z' } });
    targetFingerprintReply = body => { if (++fingerprints === 2) source.getProject(projectId)!.standbyMirror!.enabled = false; return body; };
    scheduledTick(); await vi.waitFor(() => expect(fingerprints).toBe(2));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(writes).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('a settings change during an accepted create prevents the following deployment', async () => {
    seed(source, 'main', shaA);
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: true,
      branchSyncPolicy: 'warm-running', autoFailover: false, intervalMinutes: 5, updatedAt: '2026-10-28T00:00:00Z' } });
    beforeCreate = () => { source.getProject(projectId)!.standbyMirror!.enabled = false; };
    scheduledTick(); await vi.waitFor(() => expect(target.getAllBranches()).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(deployedCommits).toEqual([]); expect(target.getAllBranches()[0].status).toBe('idle');
    expect(writes).toEqual(['/api/branches']);
  });
  it('HTTP failure evidence retains diagnostic facts while masking credentials, personal data and large text', async () => {
    seed(source, 'main', shaA);
    source.updateCdsPeer('fixture-peer', { accessKey: 'SYNTHETIC_SHARED_AUTH_SENTINEL' });
    fingerprintOverride = { status: 503, headers: { 'x-request-id': 'SYNTHETIC_SHARED_AUTH_SENTINEL' },
      type: 'application/json; charset=utf-8; token=SYNTHETIC_SHARED_AUTH_SENTINEL', body: JSON.stringify({ code: 'PEER_BUSY', message: 'retry later test.person@example.invalid +8613812345678',
      token: 'SYNTHETIC_TOKEN_SENTINEL', nested: { password: 'SYNTHETIC_PASSWORD_SENTINEL', document: 'PRIVATE_DOCUMENT_SENTINEL'.repeat(600) },
      details: { reason: 'SYNTHETIC_SHARED_AUTH_SENTINEL' } }) };
    const failure = await reconcile(); expect(failure.status).toBe(502); expect(failure.body.responseAuditId).toMatch(/^[a-f0-9-]{36}$/);
    const records = await auditSink.findRecent({ projectId }); const details = records[0].details;
    expect(details).toMatchObject({ responseReceived: true, httpStatus: 503, parseState: 'json', localDecision: 'upstream-failure', truncated: true });
    expect(details.snapshot).toContain('PEER_BUSY'); expect(details.snapshot).toContain('retry later');
    expect(Buffer.byteLength(details.snapshot)).toBeLessThanOrEqual(4096);
    const disk = fs.readFileSync(auditFile, 'utf8');
    for (const privateText of ['test.person@example.invalid', '13812345678', 'SYNTHETIC_TOKEN_SENTINEL', 'SYNTHETIC_PASSWORD_SENTINEL', 'PRIVATE_DOCUMENT_SENTINEL', 'SYNTHETIC_SHARED_AUTH_SENTINEL']) expect(disk).not.toContain(privateText);
    expect(writes).toEqual([]);
  });
  it('malformed JSON is a received parse failure with an omitted raw body, not an authentication error', async () => {
    seed(source, 'main', shaA); fingerprintOverride = { status: 200, body: 'UNSTRUCTURED_PRIVATE_SENTINEL not json', type: 'text/plain' };
    expect((await reconcile()).status).toBe(502);
    const details = (await auditSink.findRecent({ projectId }))[0].details;
    expect(details).toMatchObject({ responseReceived: true, httpStatus: 200, parseState: 'invalid-json', localDecision: 'parse-failure' });
    expect(details.originalBytes).toBeGreaterThan(0); expect(details.snapshot).toContain('unstructured response omitted');
    expect(fs.readFileSync(auditFile, 'utf8')).not.toContain('UNSTRUCTURED_PRIVATE_SENTINEL');
  });
  it('an invalid peer URL still leaves durable no-response evidence with its unsafe target omitted', async () => {
    seed(source, 'main', shaA); source.updateCdsPeer('fixture-peer', { baseUrl: 'https://invalid%20host.invalid' });
    expect((await reconcile()).status).toBe(502);
    const details = (await auditSink.findRecent({ projectId }))[0].details;
    expect(details).toMatchObject({ responseReceived: false, httpStatus: null, target: '[invalid peer URL omitted]', parseState: 'no-response' });
    expect(writes).toEqual([]);
  });
  it('a real aborted peer request persists no-response timeout facts without fabricated HTTP status', async () => {
    seed(source, 'main', shaA); fingerprintOverride = { status: 200, body: '{}', delayMs: 200 };
    const original = global.setTimeout;
    const clock = vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, ms: number, ...args: any[]) => original(callback, ms === 20_000 ? 30 : ms, ...args)) as typeof setTimeout);
    try { expect((await reconcile()).status).toBe(502); } finally { clock.mockRestore(); }
    const details = (await auditSink.findRecent({ projectId }))[0].details;
    expect(details).toMatchObject({ responseReceived: false, httpStatus: null, parseState: 'no-response', localDecision: 'timeout', originalBytes: null, snapshot: '' });
    expect(writes).toEqual([]);
  });
  it.each(['write-failed', 'silent-noop'])('an audit %s is visible and prevents untraceable branch writes', async mode => {
    seed(source, 'main', shaA);
    const spy = vi.spyOn(auditSink, 'recordImmediate').mockImplementation(async () => { if (mode === 'write-failed') throw new Error('fixture audit unavailable'); });
    try {
      const response = await reconcile(); expect(response.status).toBe(502); expect(response.body.error).toContain('审计');
      expect(writes).toEqual([]); expect(target.getAllBranches()).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it('an interrupted SSE body retains received headers and timeout stage rather than inventing a response body', async () => {
    seed(source, 'main', shaA); fingerprintOverride = { status: 200, body: '', type: 'text/event-stream', headersOnly: true };
    const original = global.setTimeout;
    const clock = vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, ms: number, ...args: any[]) => original(callback, ms === 20_000 ? 50 : ms, ...args)) as typeof setTimeout);
    try { expect((await reconcile()).status).toBe(502); } finally { clock.mockRestore(); }
    const details = (await auditSink.findRecent({ projectId }))[0].details;
    expect(details).toMatchObject({ responseReceived: true, httpStatus: 200, parseState: 'body-read-failed', localDecision: 'timeout', originalBytes: null, snapshot: '' });
    expect(details.contentType).toContain('text/event-stream'); expect(writes).toEqual([]);
  });
  it('persists the peer SSE error reason despite normalized local deployment failure', async () => {
    seed(source, 'main', shaA); seed(target, 'main', shaA, 'idle'); deployOutcome = 'error';
    expect((await reconcile('warm-running')).status).toBe(207);
    const records = await auditSink.findRecent({ projectId });
    expect(records.some(record => record.details?.localDecision === 'upstream-failure'
      && record.details?.snapshot.includes('fixture failure'))).toBe(true);
  });
  it('long SSE progress cannot hide the final failure or leak progress bodies into evidence', async () => {
    seed(source, 'main', shaA); seed(target, 'main', shaA, 'idle'); deployOutcome = 'long-error';
    expect((await reconcile('warm-running')).status).toBe(207);
    const record = (await auditSink.findRecent({ projectId })).find(row => row.details?.localDecision === 'upstream-failure');
    expect(record.details.snapshot).toContain('late terminal failure'); expect(record.details.snapshot).toContain('PEER_DEPLOY_FAILED');
    expect(Buffer.byteLength(record.details.snapshot)).toBeLessThanOrEqual(4096); expect(record.details.truncated).toBe(true);
    expect(fs.readFileSync(auditFile, 'utf8')).not.toContain('PRIVATE_PROGRESS_SENTINEL');
  });
  it('catalog records actual HEAD, persists it, and a second reconciliation is empty', async () => {
    seed(source, 'main', shaA);
    expect((await reconcile()).status).toBe(200);
    const entry = target.findBranchByProjectAndName(projectId, 'main')!;
    expect(git(entry.worktreePath, 'rev-parse', 'HEAD')).toBe(shaA);
    expect(entry.githubCommitSha).toBe(shaA);
    await target.flush(); const restored = new StateService(path.join(root, 'target-state.json')); restored.load();
    expect(restored.getBranch(entry.id)?.githubCommitSha).toBe(shaA);
    const again = await reconcile(); expect(again.body.result.planned).toEqual([]);
    expect(again.body.result.divergent).toEqual([]); expect(writes).toEqual(['/api/branches']);
  });
  it('rejects source A after origin advances to B without worktree or state orphan', async () => {
    seed(source, 'main', shaA); const shaB = advanceOrigin(); expect(shaB).not.toBe(shaA);
    const result = await reconcile(); expect(result.status).toBe(207); expect(result.body.result.created).toEqual([]);
    expect(result.body.result.failed).toHaveLength(1); expect(target.getAllBranches()).toEqual([]);
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });
  it('audit-only and warm-running dry-run make no state or Git writes', async () => {
    seed(source, 'main', shaA);
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: false,
      branchSyncPolicy: 'audit-only', autoFailover: false, intervalMinutes: 5, updatedAt: new Date().toISOString() } });
    await Promise.all([source.flush(), target.flush()]);
    const before = JSON.stringify([source.getState(), target.getState()]);
    expect((await reconcile('audit-only')).body.result.planned).toEqual([]);
    const warm = await reconcile('warm-running', { dryRun: true });
    expect(warm.body.result.planned.map((x: any) => x.kind)).toEqual(['create', 'deploy']);
    expect(JSON.stringify([source.getState(), target.getState()])).toBe(before);
    expect(commands).toEqual([]); expect(writes).toEqual([]);
  });
  it('catalog preserves divergent and target-only entries without reset/delete/start/stop', async () => {
    seed(source, 'main', shaA); seed(target, 'main', 'b'.repeat(40)); seed(target, 'local/debug', shaA);
    const before = JSON.stringify(target.getAllBranches()); const result = await reconcile();
    expect(result.body.result.divergent).toHaveLength(1); expect(result.body.result.created).toEqual([]);
    expect(JSON.stringify(target.getAllBranches())).toBe(before); expect(writes).toEqual([]); expect(commands).toEqual([]);
  });
  it('invalid target is rejected before creating anything', async () => {
    seed(source, 'main', shaA);
    expect((await reconcile('catalog', { remoteProjectId: 'not-a-project' })).status).toBe(502);
    expect(target.getAllBranches()).toEqual([]); expect(writes).toEqual([]); expect(commands).toEqual([]);
  });
  it('an older peer cannot silently ignore expectedCommit and create an unverified branch', async () => {
    seed(source, 'main', shaA); targetFingerprintReply = body => { delete body.capabilities; return body; };
    const result = await reconcile(); expect(result.status).toBe(207); expect(result.body.result.created).toEqual([]);
    expect(writes).toEqual([]); expect(commands).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('failed stale snapshot can retry after source is refreshed without duplicate directory', async () => {
    const entry = seed(source, 'main', shaA); const shaB = advanceOrigin();
    expect((await reconcile()).status).toBe(207); entry.githubCommitSha = shaB; entry.services.api.sourceCommitSha = shaB;
    const result = await reconcile(); expect(result.status).toBe(200); expect(result.body.result.created).toEqual(['main']);
    expect(target.getAllBranches()).toHaveLength(1);
    expect(git(target.getAllBranches()[0].worktreePath, 'rev-parse', 'HEAD')).toBe(shaB);
    expect((await reconcile()).body.result.planned).toEqual([]);
  });
  it('preserves an unregistered existing worktree directory rather than removing it', async () => {
    seed(source, 'main', shaA);
    const existing = WorktreeService.worktreePathFor(path.join(root, 'worktrees'), projectId, 'fixture-main');
    fs.mkdirSync(existing, { recursive: true }); fs.writeFileSync(path.join(existing, 'keep.txt'), 'existing work');
    expect((await reconcile()).status).toBe(207);
    expect(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8')).toBe('existing work');
    expect(target.getAllBranches()).toEqual([]); expect(commands.some(command => command.startsWith('rm -rf'))).toBe(false);
  });
  it('retains main source-free creation while verifying the remote commit', async () => {
    seed(source, 'main', shaA);
    target.addBuildProfile({ id: 'app', projectId, name: 'Synthetic prebuilt', dockerImage: 'node:22', command: 'unused',
      workDir: '.', containerPort: 8080, deployModes: { express: { prebuilt: true, dockerImage: 'fixture/never-start:sha-${CDS_COMMIT_SHA}' } } } as any);
    target.updateProject(projectId, { defaultDeployModes: { app: 'express' } });
    const result = await reconcile(); expect(result.status).toBe(200);
    const entry = target.findBranchByProjectAndName(projectId, 'main')!;
    expect(entry.githubCommitSha).toBe(shaA); expect(fs.existsSync(entry.worktreePath)).toBe(false);
    expect(commands.some(command => command.startsWith('git ls-remote'))).toBe(true);
    expect(commands.some(command => /git (fetch|worktree)/.test(command))).toBe(false);
  });
  it('a changed source snapshot between planning and action is rejected before writes', async () => {
    const entry = seed(source, 'main', shaA);
    targetFingerprintReply = body => { entry.githubCommitSha = 'b'.repeat(40); return body; };
    expect((await reconcile()).status).toBe(207);
    expect(writes).toEqual([]); expect(commands).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('missing source identity cannot create or warm a branch', async () => {
    seed(source, 'main', undefined);
    const result = await reconcile('warm-running');
    expect(result.body.result.created).toEqual([]); expect(result.body.result.deployed).toEqual([]);
    expect(writes).toEqual([]); expect(commands).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('two unknown commits never count as a matching identity for preheating', async () => {
    seed(source, 'main', undefined); seed(target, 'main', undefined, 'idle');
    const result = await reconcile('warm-running');
    expect(result.body.result.planned.map((action: any) => action.kind)).toEqual(['divergent']);
    expect(writes).toEqual([]); expect(commands).toEqual([]);
  });
  it('warm-running refuses an unverified create receipt before simulated deployment', async () => {
    seed(source, 'main', shaA); createdReply = body => ({ ...body, branch: { ...body.branch, githubCommitSha: 'f'.repeat(40) } });
    const result = await reconcile('warm-running');
    expect(result.status).toBe(207); expect(result.body.result.created).toEqual([]); expect(result.body.result.deployed).toEqual([]);
    expect(writes).toEqual(['/api/branches']);
    expect((await auditSink.findRecent({ projectId })).some(row => row.details?.snapshot.includes('f'.repeat(40)))).toBe(true);
  });
  it('warm-running uses controlled runtime mocks only for matching commits and preserves target-only', async () => {
    seed(source, 'main', shaA); seed(source, 'idle', shaA, 'idle');
    seed(target, 'idle', shaA, 'running'); seed(target, 'local/debug', shaA, 'running');
    const result = await reconcile('warm-running'); expect(result.status).toBe(200);
    expect(result.body.result.created).toEqual(['main']); expect(result.body.result.deployed).toEqual(['main']);
    expect(result.body.result.stopped).toEqual(['idle']);
    expect(deployedCommits).toEqual([shaA]);
    expect(target.findBranchByProjectAndName(projectId, 'local/debug')?.status).toBe('running');
    expect(commands.some(command => /docker/.test(command))).toBe(false);
  });
  it.each(['error', 'false', 'missing'] as const)('HTTP 200 with %s SSE outcome is not successful preheating', async outcome => {
    seed(source, 'main', shaA); deployOutcome = outcome;
    const result = await reconcile('warm-running'); expect(result.status).toBe(207);
    expect(result.body.result.deployed).toEqual([]);
    expect(result.body.result.failed).toEqual([expect.objectContaining({ name: 'main', action: 'deploy' })]);
    expect(deployedCommits).toEqual([shaA]); expect(target.getAllBranches()[0].status).toBe('idle');
  });
  it.each(['building', 'starting', 'restarting', 'error', 'unknown'])('source %s cannot mean stop even with a retained serving runtime', async status => {
    const entry = seed(source, 'main', shaA, status);
    entry.services = { app: { status: 'running', servingRuntime: { containerName: 'synthetic-retained-serving' } } } as any;
    seed(target, 'main', shaA, 'running');
    const result = await reconcile('warm-running');
    expect(result.body.result.stopped).toEqual([]); expect(result.body.result.deployed).toEqual([]);
    expect(writes).toEqual([]); expect(target.getAllBranches()[0].status).toBe('running');
  });
  it('source idle becoming running with the same SHA during the final target read cannot stop the target', async () => {
    const entry = seed(source, 'main', shaA, 'idle'); seed(target, 'main', shaA, 'running');
    let reads = 0; targetFingerprintReply = body => { if (++reads === 2) entry.status = 'running'; return body; };
    const result = await reconcile('warm-running');
    expect(result.body.result.stopped).toEqual([]); expect(writes).toEqual([]);
    expect(target.getAllBranches()[0].status).toBe('running');
  });
  it('a target pin B cannot be hidden by cached A or overwritten by source A preheating', async () => {
    seed(source, 'main', shaA); const entry = seed(target, 'main', shaA, 'idle'); entry.pinnedCommit = 'b'.repeat(40);
    const result = await reconcile('warm-running');
    expect(result.body.result.deployed).toEqual([]); expect(writes).toEqual([]);
    expect(entry.pinnedCommit).toBe('b'.repeat(40)); expect(result.body.result.divergent).toHaveLength(1);
  });
  it('matching manual target pin is preserved without automatic deploy clearing it', async () => {
    seed(source, 'main', shaA); const entry = seed(target, 'main', shaA, 'idle'); entry.pinnedCommit = shaA;
    const result = await reconcile('warm-running');
    expect(result.body.result.deployed).toEqual([]); expect(writes).toEqual([]); expect(entry.pinnedCommit).toBe(shaA);
  });
  it('a new target pin after the fingerprint response is rejected by the real deploy route before effects', async () => {
    seed(source, 'main', shaA); const entry = seed(target, 'main', shaA, 'idle'); useRealRuntimeGuard = true;
    let reads = 0; targetFingerprintReply = body => { if (++reads === 2) entry.pinnedCommit = shaA; return body; };
    const result = await reconcile('warm-running'); expect(result.status).toBe(207);
    expect(result.body.result.deployed).toEqual([]); expect(entry.pinnedCommit).toBe(shaA);
    expect(entry.status).toBe('idle'); expect(deployedCommits).toEqual([]); expect(commands).toEqual([]);
  });
  it.each(['building', 'sha-changed'])('the real stop route rejects a stale %s receiver snapshot before effects', async mutation => {
    const entry = seed(target, 'main', shaA, mutation === 'building' ? 'building' : 'running'); useRealRuntimeGuard = true;
    if (mutation === 'sha-changed') entry.githubCommitSha = 'b'.repeat(40);
    const response = await fetch(`${targetUrl}/api/branches/${entry.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standbyExpected: { commitSha: shaA, status: 'running', pinnedCommit: null, ...targetConfiguration(entry) } }) });
    expect(response.status).toBe(409); expect((await response.json() as any).error).toBe('standby_snapshot_changed');
    expect(commands).toEqual([]); expect(entry.status).toBe(mutation === 'building' ? 'building' : 'running');
  });
  it('the real stop route rejects a changed runtime even when webhook SHA and status are unchanged', async () => {
    const entry = seed(target, 'main', shaA, 'running'); useRealRuntimeGuard = true;
    entry.services.api.sourceCommitSha = 'b'.repeat(40);
    const response = await fetch(`${targetUrl}/api/branches/${entry.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standbyExpected: { commitSha: shaA, status: 'running', pinnedCommit: null, ...targetConfiguration(entry) } }) });
    expect(response.status).toBe(409); expect(commands).toEqual([]); expect(entry.services.api.sourceCommitSha).toBe('b'.repeat(40));
  });
});
